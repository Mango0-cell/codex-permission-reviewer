import { createHash } from "node:crypto";
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { lstat, open, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { homedir } from "node:os";
import { TextDecoder } from "node:util";
import { dirname, extname, isAbsolute, join, parse, resolve } from "node:path";
import type { NormalizedAction } from "../action/types.ts";
import { actionSha256 } from "../action/metadata.ts";
import { sensitiveFileTarget } from "./sensitive-paths.ts";

const MANIFEST_RELATIVE_PATH = join("plugin-state", "codex-permission-reviewer", "executable-dependencies.json");
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_ACTIONS = 8;
const MAX_DEPENDENCIES_PER_ACTION = 8;
const MAX_DEPENDENCY_BYTES = 64 * 1024 * 1024;
const MAX_DEPENDENCY_BYTES_TOTAL = 128 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 4 * 1024;
const PRIVATE_MODE = 0o600;
const PRIVATE_DIRECTORY_BITS = 0o077;
const WRITABLE_BY_OTHERS_BITS = 0o022;
const NATIVE_EXTENSIONS = new Set([".bin", ".dll", ".dylib", ".exe", ".node", ".so"]);
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const EXECUTABLE_DEPENDENCY_OPERATION_KINDS = new Set(["command", "database", "process_spawn"]);

interface FileIdentity {
  path: string;
  dev: string;
  ino: string;
  size: string;
  mode: string;
  uid: string;
  nlink: string;
  mtimeNs: string;
  ctimeNs: string;
}
interface DirectoryIdentity { path: string; dev: string; ino: string; mode: string; uid: string }
interface ManifestDependency { path: string; sha256: string }
interface ManifestAction { actionSha256: string; dependencies: ManifestDependency[] }
interface DependencySnapshot {
  actionSha256: string;
  directories: DirectoryIdentity[];
  manifest: { identity: FileIdentity; sha256: string };
  dependencies: Array<{ path: string; sha256: string; identity: FileIdentity }>;
}
export interface ExecutableDependencyProof {
  readonly actionSha256: string;
  readonly dependencies: readonly ManifestDependency[];
  readonly dependencyPolicySha256: string;
  readonly decisionSha256: string;
  readonly [verifiedExecutableDependencyProof]: true;
}

declare const verifiedExecutableDependencyProof: unique symbol;
interface ProofState { snapshot: DependencySnapshot }
const proofStates = new WeakMap<object, ProofState>();

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function identity(path: string, stats: BigIntStats): FileIdentity {
  return {
    path,
    dev: String(stats.dev),
    ino: String(stats.ino),
    size: String(stats.size),
    mode: String(stats.mode),
    uid: String(stats.uid),
    nlink: String(stats.nlink),
    mtimeNs: String(stats.mtimeNs),
    ctimeNs: String(stats.ctimeNs),
  };
}

function directoryIdentity(path: string, stats: BigIntStats): DirectoryIdentity {
  return { path, dev: String(stats.dev), ino: String(stats.ino), mode: String(stats.mode), uid: String(stats.uid) };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity) {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid;
}

function isCurrentUser(stats: BigIntStats) {
  return typeof process.getuid === "function" && stats.uid === BigInt(process.getuid());
}

function isRootOwned(stats: BigIntStats) {
  return stats.uid === 0n;
}

function canonicalDependencyPath(path: string) {
  return typeof path === "string" && path.length > 0 && path.length <= 2_048 && isAbsolute(path) &&
    resolve(path) === path && !/[?*\[\]{}]/u.test(path) && path.split(/[\\/]+/u).some((part) => part.toLocaleLowerCase() === "node_modules") &&
    !sensitiveFileTarget(path, true) && (SOURCE_EXTENSIONS.has(extname(path)) || NATIVE_EXTENSIONS.has(extname(path)) || extname(path) === "");
}

function containsNodeModulesComponent(value: string) {
  return value.split(/[\\/]+/u).some((part) => part.toLocaleLowerCase() === "node_modules");
}

export function isExecutableDependencyCandidate(action: NormalizedAction) {
  if (!EXECUTABLE_DEPENDENCY_OPERATION_KINDS.has(action.operationKind)) return false;
  return Boolean(action.command && containsNodeModulesComponent(action.command)) ||
    (action.fileTargets ?? []).some(containsNodeModulesComponent);
}

export function captureExecutableDependencyHome(configuredHome?: string): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  const environmentHome = process.env.CODEX_HOME;
  const selectedHome = configuredHome ?? (typeof environmentHome === "string" && isAbsolute(environmentHome)
    ? environmentHome
    : join(homedir(), ".codex"));
  if (!isAbsolute(selectedHome)) return Promise.resolve(null);
  const absoluteHome = resolve(selectedHome);
  return realpath(absoluteHome).then((canonical) => resolve(canonical)).catch(() => null);
}

function assertBudget(signal?: AbortSignal, remainingMs?: () => number) {
  if (signal?.aborted || (remainingMs && remainingMs() <= 0)) throw new Error("dependency verification was cancelled or timed out");
}

async function canonicalRealPath(path: string) {
  try {
    const [actual, stats] = await Promise.all([realpath(path), lstat(path, { bigint: true })]);
    if (stats.isSymbolicLink() || resolve(actual) !== path) return null;
    return stats;
  } catch {
    return null;
  }
}

function directoryChain(path: string) {
  const root = parse(path).root;
  const result = [root];
  let current = root;
  for (const segment of path.slice(root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    result.push(current);
  }
  return result;
}

async function inspectDirectories(paths: readonly string[], trustHome?: string, signal?: AbortSignal, remainingMs?: () => number): Promise<DirectoryIdentity[]> {
  if (process.platform === "win32" || !Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0) throw new Error("no-follow identity checks are unavailable");
  const allPaths = new Set<string>();
  for (const path of paths) {
    for (const directory of directoryChain(dirname(path))) allPaths.add(directory);
  }
  const ordered = [...allPaths].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const result: DirectoryIdentity[] = [];
  const directoryStats = new Map<string, BigIntStats>();
  for (const path of ordered) {
    assertBudget(signal, remainingMs);
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("a dependency directory path was not canonical");
    const stats = await canonicalRealPath(path);
    if (!stats || !stats.isDirectory()) throw new Error("a dependency parent was missing, replaced, or symlinked");
    const ownerTrusted = isCurrentUser(stats) || isRootOwned(stats);
    if (!ownerTrusted) throw new Error("a dependency parent had an untrusted owner");
    if ((stats.mode & BigInt(WRITABLE_BY_OTHERS_BITS)) !== 0n && !((stats.mode & 0o1000n) !== 0n && isRootOwned(stats))) {
      throw new Error("a dependency parent was writable by other users");
    }
    directoryStats.set(path, stats);
    result.push(directoryIdentity(path, stats));
  }
  if (trustHome) {
    const homeStats = directoryStats.get(trustHome);
    if (!homeStats || !isCurrentUser(homeStats) || (homeStats.mode & BigInt(PRIVATE_DIRECTORY_BITS)) !== 0n) {
      throw new Error("the executable dependency policy home was not owner-private");
    }
  }
  // A sticky shared temporary ancestor is safe only when the path descends into
  // an owner-private directory before reaching the file being verified.
  for (const filePath of paths) {
    const chain = directoryChain(dirname(filePath));
    for (let index = 0; index < chain.length; index += 1) {
      const path = chain[index]!;
      const stats = directoryStats.get(path)!;
      if ((stats.mode & 0o1000n) !== 0n && isRootOwned(stats)) {
        const privateDescendant = chain.slice(index + 1).some((candidate) => {
          const candidateStats = directoryStats.get(candidate);
          return Boolean(candidateStats && isCurrentUser(candidateStats) &&
            (candidateStats.mode & BigInt(PRIVATE_DIRECTORY_BITS)) === 0n);
        });
        if (!privateDescendant) throw new Error("a sticky temporary parent had no owner-private descendant");
      }
    }
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function parseManifest(bytes: Buffer, boundActionSha256: string): ManifestAction | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("the executable dependency manifest was not UTF-8");
  }
  const parsed: unknown = JSON.parse(text);
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ["version", "actions"]) || parsed.version !== 1 ||
      !Array.isArray(parsed.actions) || parsed.actions.length > MAX_MANIFEST_ACTIONS) {
    throw new Error("the executable dependency manifest had an unsupported schema");
  }
  const actions: ManifestAction[] = [];
  let matched: ManifestAction | null = null;
  for (const rawAction of parsed.actions) {
    if (!isPlainRecord(rawAction) || !hasExactKeys(rawAction, ["actionSha256", "dependencies"]) ||
        typeof rawAction.actionSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(rawAction.actionSha256) ||
        !Array.isArray(rawAction.dependencies) || rawAction.dependencies.length === 0 || rawAction.dependencies.length > MAX_DEPENDENCIES_PER_ACTION) {
      throw new Error("the executable dependency manifest contained an invalid action");
    }
    const dependencies: ManifestDependency[] = [];
    for (const rawDependency of rawAction.dependencies) {
      if (!isPlainRecord(rawDependency) || !hasExactKeys(rawDependency, ["path", "sha256"]) ||
          typeof rawDependency.path !== "string" || !canonicalDependencyPath(rawDependency.path) ||
          typeof rawDependency.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(rawDependency.sha256)) {
        throw new Error("the executable dependency manifest contained an invalid dependency");
      }
      dependencies.push({ path: rawDependency.path, sha256: rawDependency.sha256 });
    }
    if (new Set(dependencies.map((dependency) => dependency.path)).size !== dependencies.length) {
      throw new Error("the executable dependency manifest repeated a path");
    }
    const action = { actionSha256: rawAction.actionSha256, dependencies };
    actions.push(action);
    if (rawAction.actionSha256 === boundActionSha256) {
      if (matched) throw new Error("the executable dependency manifest repeated an action digest");
      matched = action;
    }
  }
  if (new Set(actions.map((entry) => entry.actionSha256)).size !== actions.length) {
    throw new Error("the executable dependency manifest repeated an action digest");
  }
  return matched;
}

async function readBoundedFile(path: string, maximumBytes: number, expectedMode: number | null, signal?: AbortSignal, remainingMs?: () => number) {
  assertBudget(signal, remainingMs);
  const before = await canonicalRealPath(path);
  if (!before || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > BigInt(maximumBytes)) {
    throw new Error("a required policy file was missing, linked, non-regular, empty, or oversized");
  }
  if (!isCurrentUser(before)) throw new Error("a required policy file had an untrusted owner");
  if (expectedMode !== null && (before.mode & 0o777n) !== BigInt(expectedMode)) throw new Error("the executable dependency manifest was not owner-private");
  if (expectedMode === null && (before.mode & BigInt(WRITABLE_BY_OTHERS_BITS)) !== 0n) throw new Error("an executable dependency was writable by other users");

  const handle = await open(path, O_RDONLY | O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    const openedIdentity = identity(path, opened);
    const beforeIdentity = identity(path, before);
    if (!opened.isFile() || !sameIdentity(beforeIdentity, openedIdentity)) throw new Error("a policy file changed before it was opened");
    const expectedSize = Number(opened.size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize > maximumBytes) throw new Error("a policy file exceeded its read limit");
    const buffer = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      assertBudget(signal, remainingMs);
      const length = Math.min(READ_CHUNK_BYTES, expectedSize - offset);
      const { bytesRead } = await handle.read(buffer, offset, length, offset);
      if (bytesRead <= 0) throw new Error("a policy file changed while it was read");
      offset += bytesRead;
    }
    assertBudget(signal, remainingMs);
    const [afterHandle, afterPath, afterRealPath] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path),
    ]);
    if (resolve(afterRealPath) !== path || !sameIdentity(openedIdentity, identity(path, afterHandle)) ||
        !sameIdentity(openedIdentity, identity(path, afterPath))) throw new Error("a policy file changed during its bounded read");
    return { bytes: buffer, identity: openedIdentity };
  } finally {
    await handle.close();
  }
}

function nativeExecutableHeader(prefix: Buffer) {
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true;
  if (prefix.length >= 4 && ["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(prefix.subarray(0, 4).toString("hex"))) return true;
  if (prefix.length >= 64 && prefix[0] === 0x4d && prefix[1] === 0x5a) {
    const headerOffset = prefix.readUInt32LE(0x3c);
    return headerOffset + 4 <= prefix.length && prefix.subarray(headerOffset, headerOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]));
  }
  return false;
}

async function readDependency(path: string, expectedSha256: string, before: BigIntStats, signal?: AbortSignal, remainingMs?: () => number) {
  assertBudget(signal, remainingMs);
  if (!canonicalDependencyPath(path) || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n ||
      before.size <= 0n || before.size > BigInt(MAX_DEPENDENCY_BYTES)) throw new Error("an executable dependency was not a bounded regular file");
  if (!isCurrentUser(before) && !isRootOwned(before)) throw new Error("an executable dependency had an untrusted owner");
  if ((before.mode & BigInt(WRITABLE_BY_OTHERS_BITS)) !== 0n) throw new Error("an executable dependency was writable by other users");
  const extension = extname(path);
  const native = NATIVE_EXTENSIONS.has(extension) || extension === "";
  if (native && (before.mode & 0o111n) === 0n) throw new Error("a native dependency was not executable");

  const handle = await open(path, O_RDONLY | O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    const expectedIdentity = identity(path, before);
    const openedIdentity = identity(path, opened);
    if (!opened.isFile() || !sameIdentity(expectedIdentity, openedIdentity)) throw new Error("an executable dependency changed before it was opened");
    const size = Number(opened.size);
    if (!Number.isSafeInteger(size) || size > MAX_DEPENDENCY_BYTES) throw new Error("an executable dependency exceeded its read limit");
    const prefix = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
    let position = 0;
    while (position < prefix.length) {
      assertBudget(signal, remainingMs);
      const { bytesRead } = await handle.read(prefix, position, prefix.length - position, position);
      if (bytesRead <= 0) throw new Error("an executable dependency changed while its header was read");
      position += bytesRead;
    }
    if (native && !nativeExecutableHeader(prefix)) throw new Error("a native dependency did not have a recognized executable format");

    const digest = createHash("sha256").update(prefix);
    while (position < size) {
      assertBudget(signal, remainingMs);
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead <= 0) throw new Error("an executable dependency changed while it was read");
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const actualSha256 = digest.digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error("an executable dependency did not match its pinned hash");
    assertBudget(signal, remainingMs);
    const [afterHandle, afterPath, afterRealPath] = await Promise.all([
      handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path),
    ]);
    if (resolve(afterRealPath) !== path || !sameIdentity(openedIdentity, identity(path, afterHandle)) ||
        !sameIdentity(openedIdentity, identity(path, afterPath))) throw new Error("an executable dependency changed during its bounded read");
    return { sha256: actualSha256, identity: openedIdentity };
  } finally {
    await handle.close();
  }
}

function snapshotFingerprint(snapshot: DependencySnapshot) {
  return sha256(JSON.stringify(snapshot));
}

async function verifySnapshot(action: NormalizedAction, home: string, signal?: AbortSignal, remainingMs?: () => number): Promise<DependencySnapshot> {
  if (process.platform === "win32" || !Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0) throw new Error("no-follow dependency verification is unsupported");
  const actionDigest = actionSha256(action);
  const manifestPath = join(home, MANIFEST_RELATIVE_PATH);
  const directories = await inspectDirectories([manifestPath], home, signal, remainingMs);
  const manifestFile = await readBoundedFile(manifestPath, MAX_MANIFEST_BYTES, PRIVATE_MODE, signal, remainingMs);
  const matching = parseManifest(manifestFile.bytes, actionDigest);
  if (!matching) throw new Error("the manifest did not pin this exact action");
  const aggregateSizes = new Map<string, BigIntStats>();
  let aggregateBytes = 0;
  for (const dependency of matching.dependencies) {
    assertBudget(signal, remainingMs);
    if (!(action.fileTargets ?? []).includes(dependency.path)) {
      throw new Error("a pinned dependency was not an exact action target");
    }
    const stats = await canonicalRealPath(dependency.path);
    if (!stats || !stats.isFile() || stats.nlink !== 1n || stats.size <= 0n || stats.size > BigInt(MAX_DEPENDENCY_BYTES)) {
      throw new Error("a pinned dependency was missing, linked, non-regular, or oversized");
    }
    if (sensitiveFileTarget(dependency.path, true)) throw new Error("a pinned dependency path contained a protected component");
    aggregateBytes += Number(stats.size);
    if (aggregateBytes > MAX_DEPENDENCY_BYTES_TOTAL) throw new Error("pinned dependencies exceeded their aggregate read limit");
    aggregateSizes.set(dependency.path, stats);
  }
  const dependencyDirectories = await inspectDirectories(matching.dependencies.map((dependency) => dependency.path), undefined, signal, remainingMs);
  const allDirectories = new Map<string, DirectoryIdentity>(directories.map((entry) => [entry.path, entry]));
  for (const directory of dependencyDirectories) {
    const previous = allDirectories.get(directory.path);
    if (previous && !sameDirectoryIdentity(previous, directory)) throw new Error("a policy parent changed before dependency hashing");
    allDirectories.set(directory.path, directory);
  }
  const dependencies: DependencySnapshot["dependencies"] = [];
  for (const dependency of matching.dependencies) {
    const before = aggregateSizes.get(dependency.path);
    if (!before) throw new Error("a pinned dependency disappeared");
    const verified = await readDependency(dependency.path, dependency.sha256, before, signal, remainingMs);
    dependencies.push({ path: dependency.path, sha256: verified.sha256, identity: verified.identity });
  }
  const finalDirectories = await inspectDirectories([manifestPath, ...matching.dependencies.map((entry) => entry.path)], home, signal, remainingMs);
  for (const current of finalDirectories) {
    const original = allDirectories.get(current.path);
    if (!original || !sameDirectoryIdentity(original, current)) throw new Error("a policy parent changed during dependency verification");
  }
  // Run a final metadata-only sweep after checking parents so an earlier file
  // cannot stay stale while a later dependency is being hashed.
  for (const dependency of dependencies) {
    assertBudget(signal, remainingMs);
    const current = await canonicalRealPath(dependency.path);
    if (!current || !sameIdentity(dependency.identity, identity(dependency.path, current))) {
      throw new Error("an executable dependency changed after the complete hash pass");
    }
  }
  assertBudget(signal, remainingMs);
  const manifestPathNow = await canonicalRealPath(manifestPath);
  if (!manifestPathNow || !sameIdentity(manifestFile.identity, identity(manifestPath, manifestPathNow))) {
    throw new Error("the executable dependency manifest changed after verification");
  }
  return {
    actionSha256: actionDigest,
    directories: [...allDirectories.values()].sort((left, right) => left.path.localeCompare(right.path)),
    manifest: { identity: manifestFile.identity, sha256: sha256(manifestFile.bytes) },
    dependencies,
  };
}

export async function verifyExecutableDependencies(
  action: NormalizedAction,
  home: string | null,
  options: { signal?: AbortSignal; remainingMs?: () => number } = {},
): Promise<ExecutableDependencyProof | null> {
  if (!home || !isExecutableDependencyCandidate(action) || action.userAuthorization !== "explicit") return null;
  try {
    const snapshot = await verifySnapshot(action, home, options.signal, options.remainingMs);
    const dependencyPolicySha256 = snapshotFingerprint(snapshot);
    const decisionSha256 = sha256(JSON.stringify({ actionSha256: snapshot.actionSha256, dependencyPolicySha256 }));
    const proof = Object.freeze({
      actionSha256: snapshot.actionSha256,
      dependencies: Object.freeze(snapshot.dependencies.map(({ path, sha256: digest }) => Object.freeze({ path, sha256: digest }))),
      dependencyPolicySha256,
      decisionSha256,
    }) as ExecutableDependencyProof;
    proofStates.set(proof, { snapshot });
    return proof;
  } catch {
    return null;
  }
}

export async function reverifyExecutableDependencies(
  action: NormalizedAction,
  home: string | null,
  proof: ExecutableDependencyProof,
  options: { signal?: AbortSignal; remainingMs?: () => number } = {},
) {
  const state = proofStates.get(proof);
  if (!state || !home || proof.actionSha256 !== actionSha256(action)) return false;
  try {
    const current = await verifySnapshot(action, home, options.signal, options.remainingMs);
    return JSON.stringify(current) === JSON.stringify(state.snapshot) && proof.dependencyPolicySha256 === snapshotFingerprint(current);
  } catch {
    return false;
  }
}

export function isExecutableDependencyProofForAction(proof: ExecutableDependencyProof | undefined, action: NormalizedAction) {
  if (!proof || !proofStates.has(proof) || proof.actionSha256 !== actionSha256(action)) return false;
  const state = proofStates.get(proof);
  return Boolean(state && state.snapshot.actionSha256 === proof.actionSha256 &&
    proof.dependencyPolicySha256 === snapshotFingerprint(state.snapshot));
}

export function isVerifiedExecutableDependencyPath(proof: ExecutableDependencyProof | undefined, action: NormalizedAction, path: string) {
  if (!proof || !isExecutableDependencyProofForAction(proof, action)) return false;
  return proof.dependencies.some((dependency) => dependency.path === path);
}
