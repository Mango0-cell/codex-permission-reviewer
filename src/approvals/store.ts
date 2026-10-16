import type { NormalizedAction } from "../action/types.ts";
import type { BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LEARNED_APPROVAL_TTL_MS, MAX_LEARNED_APPROVALS, LEARNED_APPROVAL_POLICY_VERSION, LEARNED_APPROVAL_STATE_FILENAME } from '../config.ts';
import { isPlainObject, canonicalActionJson } from '../action/metadata.ts';

interface LearnedApproval { digest: string; expiresAtMs: number; approvedAtMs?: number }
interface StoreIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
}
interface ApprovalIndex {
  statePath: string;
  identity: StoreIdentity;
  approvals: LearnedApproval[];
  expirationsByDigest: Map<string, number>;
}
interface PendingRead {
  statePath: string;
  identity: StoreIdentity;
  promise: Promise<ApprovalIndex>;
}

const MAX_APPROVAL_STATE_BYTES = 64 * 1024;
const OWNER_PRIVATE_MODE = 0o600;

let approvalIndex: ApprovalIndex | null = null;
let pendingRead: PendingRead | null = null;
let rememberQueue: Promise<void> = Promise.resolve();

function learnedApprovalSha256(action: NormalizedAction) {
  return createHash("sha256")
    .update(`policy:${LEARNED_APPROVAL_POLICY_VERSION}:`)
    .update(canonicalActionJson({ ...action, userAuthorization: "none" }), "utf8")
    .digest("hex");
}

function configuredCodexHome() {
  const configuredHome = process.env.CODEX_HOME;
  return resolve(typeof configuredHome === "string" && isAbsolute(configuredHome)
    ? configuredHome
    : join(homedir(), ".codex"));
}

function sameIdentity(left: StoreIdentity, right: StoreIdentity) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}

function identityOf(stats: BigIntStats): StoreIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    mode: stats.mode,
  };
}

function isOwnedByCurrentUser(stats: BigIntStats) {
  return typeof process.getuid !== "function" || stats.uid === BigInt(process.getuid());
}

function assertTrustedDirectory(path: string, stats: BigIntStats) {
  if (stats.isSymbolicLink() || !stats.isDirectory() || !isOwnedByCurrentUser(stats)) {
    throw new Error("learned approval state directory was not trusted");
  }
  if (process.platform !== "win32" && (stats.mode & 0o022n) !== 0n) {
    throw new Error("learned approval state directory was writable by other users");
  }
  if (resolve(path) !== path) throw new Error("learned approval state path was not canonical");
}

async function trustedStatePath(createDirectories: boolean): Promise<string | null> {
  const codexHome = configuredCodexHome();
  if (createDirectories) await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });

  let currentDirectory: string;
  try {
    currentDirectory = resolve(await fs.realpath(codexHome));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && !createDirectories) return null;
    throw error;
  }
  for (const segment of ["", "plugin-state", "codex-permission-reviewer"]) {
    if (segment) currentDirectory = join(currentDirectory, segment);
    if (createDirectories && segment) {
      try {
        await fs.mkdir(currentDirectory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }
    }
    let stats: BigIntStats;
    try {
      stats = await fs.lstat(currentDirectory, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && !createDirectories) return null;
      throw error;
    }
    assertTrustedDirectory(currentDirectory, stats);
  }
  return join(currentDirectory, LEARNED_APPROVAL_STATE_FILENAME);
}

function assertTrustedStateFile(stats: BigIntStats) {
  if (stats.isSymbolicLink() || !stats.isFile() || !isOwnedByCurrentUser(stats)) {
    throw new Error("learned approval state file was not trusted");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777n) !== BigInt(OWNER_PRIVATE_MODE)) {
    throw new Error("learned approval state file did not have owner-only permissions");
  }
  if (stats.size > BigInt(MAX_APPROVAL_STATE_BYTES)) {
    throw new Error("learned approval state exceeded the size limit");
  }
}

function parseLearnedApprovals(raw: string): LearnedApproval[] {
  if (Buffer.byteLength(raw, "utf8") > MAX_APPROVAL_STATE_BYTES) {
    throw new Error("learned approval state exceeded the size limit");
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed) || parsed.version !== LEARNED_APPROVAL_POLICY_VERSION || !Array.isArray(parsed.approvals)) {
    throw new Error("learned approval state was invalid");
  }
  return parsed.approvals
    .filter((entry: unknown): entry is LearnedApproval => isPlainObject(entry) && typeof entry.digest === "string" && /^[a-f0-9]{64}$/u.test(entry.digest) && typeof entry.expiresAtMs === "number" && Number.isFinite(entry.expiresAtMs))
    .slice(-MAX_LEARNED_APPROVALS);
}

function indexOf(statePath: string, identity: StoreIdentity, approvals: LearnedApproval[]): ApprovalIndex {
  const expirationsByDigest = new Map<string, number>();
  for (const approval of approvals) {
    const previousExpiry = expirationsByDigest.get(approval.digest);
    if (previousExpiry === undefined || approval.expiresAtMs > previousExpiry) {
      expirationsByDigest.set(approval.digest, approval.expiresAtMs);
    }
  }
  return { statePath, identity, approvals, expirationsByDigest };
}

async function readStateFile(statePath: string, expectedIdentity: StoreIdentity): Promise<ApprovalIndex> {
  if (await trustedStatePath(false) !== statePath) {
    throw new Error("learned approval state directory changed before it could be read");
  }
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow <= 0) {
    throw new Error("no-follow approval state reads are unsupported");
  }

  const handle = await fs.open(statePath, constants.O_RDONLY | noFollow);
  try {
    const openedStats = await handle.stat({ bigint: true });
    assertTrustedStateFile(openedStats);
    if (!sameIdentity(expectedIdentity, identityOf(openedStats))) {
      throw new Error("learned approval state changed before it could be read");
    }
    const currentStats = await fs.lstat(statePath, { bigint: true });
    assertTrustedStateFile(currentStats);
    if (!sameIdentity(expectedIdentity, identityOf(currentStats))) {
      throw new Error("learned approval state changed before it could be read");
    }

    const buffer = Buffer.alloc(MAX_APPROVAL_STATE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_APPROVAL_STATE_BYTES) {
      throw new Error("learned approval state exceeded the size limit");
    }

    const afterReadStats = await handle.stat({ bigint: true });
    const afterReadPathStats = await fs.lstat(statePath, { bigint: true });
    assertTrustedStateFile(afterReadStats);
    assertTrustedStateFile(afterReadPathStats);
    if (!sameIdentity(expectedIdentity, identityOf(afterReadStats)) || !sameIdentity(expectedIdentity, identityOf(afterReadPathStats)) || await trustedStatePath(false) !== statePath) {
      throw new Error("learned approval state changed while it was read");
    }

    return indexOf(statePath, expectedIdentity, parseLearnedApprovals(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await handle.close();
  }
}

function clearApprovalIndex() {
  approvalIndex = null;
}

async function loadIndex(statePath: string, identity: StoreIdentity) {
  const existingRead = pendingRead;
  if (existingRead?.statePath === statePath && sameIdentity(existingRead.identity, identity)) {
    return existingRead.promise;
  }

  const read: PendingRead = {
    statePath,
    identity,
    promise: readStateFile(statePath, identity),
  };
  pendingRead = read;
  try {
    const loaded = await read.promise;
    if (pendingRead === read) approvalIndex = loaded;
    return loaded;
  } finally {
    if (pendingRead === read) pendingRead = null;
  }
}

async function findCurrentApprovals(statePath: string): Promise<LearnedApproval[]> {
  const stats = await fs.lstat(statePath, { bigint: true });
  assertTrustedStateFile(stats);
  const loaded = await readStateFile(statePath, identityOf(stats));
  return loaded.approvals;
}

async function persistApproval(action: NormalizedAction) {
  const statePath = await trustedStatePath(true);
  if (!statePath) throw new Error("learned approval state directory was unavailable");
  const now = Date.now();
  const digest = learnedApprovalSha256(action);
  let approvals: LearnedApproval[] = [];
  try {
    approvals = await findCurrentApprovals(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // A malformed or untrusted store is reset only after an explicit eligible approval.
      approvals = [];
    }
  }
  approvals = approvals.filter((entry) => entry.expiresAtMs > now && entry.digest !== digest);
  approvals.push({ digest, approvedAtMs: now, expiresAtMs: now + LEARNED_APPROVAL_TTL_MS });
  approvals = approvals.slice(-MAX_LEARNED_APPROVALS);

  let existingStats: BigIntStats | null = null;
  try {
    existingStats = await fs.lstat(statePath, { bigint: true });
    assertTrustedStateFile(existingStats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const stateDirectory = dirname(statePath);
  const temporaryPath = join(stateDirectory, `.${LEARNED_APPROVAL_STATE_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify({ version: LEARNED_APPROVAL_POLICY_VERSION, approvals })}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_APPROVAL_STATE_BYTES) {
    throw new Error("learned approval state exceeded the size limit");
  }

  let temporaryHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let temporaryCreated = false;
  try {
    temporaryHandle = await fs.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), OWNER_PRIVATE_MODE);
    temporaryCreated = true;
    await temporaryHandle.writeFile(serialized, { encoding: "utf8" });
    await temporaryHandle.chmod(OWNER_PRIVATE_MODE);
    await temporaryHandle.close();
    temporaryHandle = null;

    if (await trustedStatePath(false) !== statePath) {
      throw new Error("learned approval state directory changed before it could be replaced");
    }
    if (existingStats) {
      const currentStats = await fs.lstat(statePath, { bigint: true });
      assertTrustedStateFile(currentStats);
      if (!sameIdentity(identityOf(existingStats), identityOf(currentStats))) {
        throw new Error("learned approval state changed before it could be replaced");
      }
    } else {
      try {
        await fs.lstat(statePath, { bigint: true });
        throw new Error("learned approval state appeared before it could be created");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }
    }
    await fs.rename(temporaryPath, statePath);
    temporaryCreated = false;
  } finally {
    if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
    if (temporaryCreated) await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }

  clearApprovalIndex();
  try {
    const stats = await fs.lstat(statePath, { bigint: true });
    assertTrustedStateFile(stats);
    const loaded = await readStateFile(statePath, identityOf(stats));
    approvalIndex = loaded;
  } catch {
    // The successful write remains durable; a later lookup will safely reload it.
    clearApprovalIndex();
  }
}

export async function hasLearnedApproval(action: NormalizedAction) {
  const digest = learnedApprovalSha256(action);
  let statePath: string | null;
  try {
    statePath = await trustedStatePath(false);
    if (!statePath) {
      clearApprovalIndex();
      return false;
    }
    const stats = await fs.lstat(statePath, { bigint: true });
    assertTrustedStateFile(stats);
    const identity = identityOf(stats);
    if (approvalIndex?.statePath === statePath && sameIdentity(approvalIndex.identity, identity)) {
      const expiresAtMs = approvalIndex.expirationsByDigest.get(digest);
      return expiresAtMs !== undefined && expiresAtMs > Date.now();
    }
    const loaded = await loadIndex(statePath, identity);
    const expiresAtMs = loaded.expirationsByDigest.get(digest);
    return expiresAtMs !== undefined && expiresAtMs > Date.now();
  } catch (error) {
    clearApprovalIndex();
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

export async function rememberLearnedApproval(action: NormalizedAction) {
  const next = rememberQueue.catch(() => undefined).then(() => persistApproval(action));
  rememberQueue = next;
  try {
    await next;
  } finally {
    if (rememberQueue === next) rememberQueue = Promise.resolve();
  }
}
