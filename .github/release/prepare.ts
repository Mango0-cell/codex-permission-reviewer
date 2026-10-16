import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const PACKAGE_NAME = "codex-permission-reviewer";
const REPOSITORY_OWNER = "adriancho91s";
const RELEASE_ARTIFACT_DIRECTORY = ".release-artifacts";
const README_INSTALL_PIN = new RegExp(
  `(github:${REPOSITORY_OWNER}/${PACKAGE_NAME}#v)([^\\s\\x60]+)`,
  "gu",
);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

interface JsonObject {
  [key: string]: unknown;
}

export interface ReleaseContext {
  cwd: string;
  nextRelease: { version: string };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(text: string, file: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new TypeError(`${file} must contain a JSON object.`);
  return value;
}

function assertSemver(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new TypeError(`${label} must be a valid semantic version.`);
  }
}

function expectObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function setCurrentVersion(actual: unknown, currentVersion: string, file: string): void {
  if (actual !== currentVersion) {
    throw new Error(`${file} version ${String(actual)} does not match the shared source version ${currentVersion}.`);
  }
}

function isErrnoError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function updateReadmePins(readme: string, currentVersion: string, nextVersion: string): string {
  let count = 0;
  const updated = readme.replace(README_INSTALL_PIN, (_match, prefix: string, version: string) => {
    setCurrentVersion(version, currentVersion, "README GitHub source pin");
    count += 1;
    return `${prefix}${nextVersion}`;
  });
  if (count === 0) throw new Error("Expected at least one version-pinned README install command.");
  return updated;
}

function serializeJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Synchronize every maintained source-install version surface before release. */
export async function synchronizeReleaseMetadata(rootDirectory: string, nextVersion: string): Promise<void> {
  assertSemver(nextVersion, "Next release version");
  const root = resolve(rootDirectory);
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const pluginPath = join(root, ".codex-plugin", "plugin.json");
  const sourceVersionPath = join(root, "src", "version.ts");
  const readmePath = join(root, "README.md");

  const [packageText, lockText, pluginText, sourceText, readmeText] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(lockPath, "utf8"),
    readFile(pluginPath, "utf8"),
    readFile(sourceVersionPath, "utf8"),
    readFile(readmePath, "utf8"),
  ]);
  const packageJson = readJsonObject(packageText, "package.json");
  const packageLock = readJsonObject(lockText, "package-lock.json");
  const pluginManifest = readJsonObject(pluginText, ".codex-plugin/plugin.json");
  if (packageJson.name !== PACKAGE_NAME) throw new Error(`package.json must describe ${PACKAGE_NAME}.`);
  if (packageLock.name !== PACKAGE_NAME) throw new Error(`package-lock.json must describe ${PACKAGE_NAME}.`);
  if (pluginManifest.name !== PACKAGE_NAME) throw new Error(`.codex-plugin/plugin.json must describe ${PACKAGE_NAME}.`);

  assertSemver(packageJson.version, "package.json version");
  const currentVersion = packageJson.version;
  setCurrentVersion(packageLock.version, currentVersion, "package-lock.json");
  const lockRoot = expectObject(expectObject(packageLock.packages, "package-lock.json packages")[""], 'package-lock.json packages[""]');
  if (lockRoot.name !== PACKAGE_NAME) throw new Error('package-lock.json packages[""] must describe the package name.');
  setCurrentVersion(lockRoot.version, currentVersion, 'package-lock.json packages[""].version');
  setCurrentVersion(pluginManifest.version, currentVersion, ".codex-plugin/plugin.json");

  const sourceMatches = [...sourceText.matchAll(/^export const PACKAGE_VERSION = "([^"]+)";$/gmu)];
  if (sourceMatches.length !== 1) throw new Error("src/version.ts must export exactly one PACKAGE_VERSION literal.");
  setCurrentVersion(sourceMatches[0]?.[1], currentVersion, "src/version.ts");

  const updatedReadme = updateReadmePins(readmeText, currentVersion, nextVersion);
  packageJson.version = nextVersion;
  packageLock.version = nextVersion;
  lockRoot.version = nextVersion;
  pluginManifest.version = nextVersion;
  const updatedSource = sourceText.replace(
    /^export const PACKAGE_VERSION = "[^"]+";$/mu,
    `export const PACKAGE_VERSION = "${nextVersion}";`,
  );

  await writeFile(packagePath, serializeJson(packageJson));
  await writeFile(lockPath, serializeJson(packageLock));
  await writeFile(pluginPath, serializeJson(pluginManifest));
  await writeFile(sourceVersionPath, updatedSource);
  await writeFile(readmePath, updatedReadme);
}

function runNpm(root: string, args: string[]): Promise<string> {
  const sanitizedEnvironment = { ...process.env };
  for (const key of Object.keys(sanitizedEnvironment)) {
    if (/(?:TOKEN|PASSWORD|AUTH|SECRET|CREDENTIAL|PRIVATE_KEY)/iu.test(key)) delete sanitizedEnvironment[key];
  }
  sanitizedEnvironment.NPM_CONFIG_USERCONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
  return new Promise((resolveOutput, reject) => {
    execFile("npm", args, { cwd: root, env: sanitizedEnvironment, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`npm ${args.join(" ")} failed: ${stderr || error.message}`, { cause: error }));
        return;
      }
      resolveOutput(stdout);
    });
  });
}

async function prepareArtifactDirectory(root: string): Promise<string> {
  const target = resolve(root, RELEASE_ARTIFACT_DIRECTORY);
  const relativePath = relative(root, target);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Release artifact directory must remain inside the repository.");
  }
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Release artifact path must be a regular directory.");
    }
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if (isErrnoError(error, "ENOENT")) {
      // The release artifact directory is created for each release attempt.
    } else {
      throw error;
    }
  }
  await mkdir(target, { recursive: false });
  return target;
}

function assertPackResult(stdout: string, version: string): string {
  const output: unknown = JSON.parse(stdout);
  if (!Array.isArray(output) || output.length !== 1 || !isJsonObject(output[0]) || typeof output[0].filename !== "string") {
    throw new Error("npm pack must produce exactly one JSON-described archive.");
  }
  const expectedFilename = `${PACKAGE_NAME}-${version}.tgz`;
  if (output[0].filename !== expectedFilename) {
    throw new Error(`npm pack produced ${output[0].filename}; expected ${expectedFilename}.`);
  }
  return expectedFilename;
}

/** semantic-release prepare hook: verify, build and archive the synchronized source. */
export async function prepare(_pluginOptions: unknown, context: ReleaseContext): Promise<void> {
  const root = resolve(context.cwd);
  await synchronizeReleaseMetadata(root, context.nextRelease.version);
  await runNpm(root, ["run", "check"]);
  await runNpm(root, ["test"]);
  await runNpm(root, ["run", "test:package"]);

  const artifactDirectory = await prepareArtifactDirectory(root);
  const packOutput = await runNpm(root, [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    artifactDirectory,
  ]);
  const archiveFilename = assertPackResult(packOutput, context.nextRelease.version);
  const artifactEntries = await readdir(artifactDirectory, { withFileTypes: true });
  if (artifactEntries.length !== 1 || artifactEntries[0]?.name !== archiveFilename || !artifactEntries[0].isFile()) {
    throw new Error("Release artifact directory must contain only the expected archive.");
  }
  const archivePath = join(artifactDirectory, archiveFilename);
  const archive = await lstat(archivePath);
  if (archive.isSymbolicLink() || !archive.isFile()) {
    throw new Error("npm pack did not produce a regular release archive.");
  }
}
