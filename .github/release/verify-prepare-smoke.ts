import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_PROTOCOL_VERSION } from "../../src/config.ts";
import { PACKAGE_VERSION } from "../../src/version.ts";

interface PrepareContext {
  cwd: string;
  nextRelease: { version: string };
}

interface FixtureLogger {
  scopeName: string;
  scope(name: string, pluginName?: string): FixtureLogger;
  log(...values: unknown[]): void;
  success(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
}

interface PreparePluginContext extends PrepareContext {
  options: { dryRun: boolean };
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  logger: FixtureLogger;
}

type PreparePluginValidator = (context: PreparePluginContext) => Promise<void>;
type NormalizePlugin = (
  context: Pick<PreparePluginContext, "cwd" | "stdout" | "stderr" | "logger"> & { options: { dryRun: boolean } },
  type: "prepare",
  plugin: string,
  pluginsPath: Record<string, string>,
) => Promise<PreparePluginValidator>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `${command} ${args.join(" ")} failed`);
  return result.stdout;
}

function isolatedNpmEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/(?:TOKEN|PASSWORD|AUTH|SECRET|CREDENTIAL|PRIVATE_KEY)/iu.test(key)) delete environment[key];
  }
  environment.NPM_CONFIG_USERCONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
  return environment;
}

function nextFixtureVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version);
  assert.ok(match, "the shared release version must have a numeric semantic-version core");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

const root = resolve(process.cwd());
const temporary = await mkdtemp(join(tmpdir(), "reviewer-versioned-release-"));
const source = join(temporary, "source");
const consumer = join(temporary, "consumer");
const environment = isolatedNpmEnvironment();
const nextVersion = nextFixtureVersion(PACKAGE_VERSION);
try {
  run("git", ["clone", "--quiet", "--no-hardlinks", root, source]);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: source, env: environment });

  const config = JSON.parse(await readFile(resolve(root, ".releaserc.json"), "utf8")) as {
    plugins: (string | [string, Record<string, unknown>])[];
  };
  const preparePlugin = config.plugins.find(plugin => typeof plugin === "string" && plugin.endsWith("/dist/.github/release/prepare.js"));
  if (typeof preparePlugin !== "string") throw new Error("Release config must register the typed prepare plugin.");
  const normalizerUrl = pathToFileURL(resolve(root, ".github/release/node_modules/semantic-release/lib/plugins/normalize.js")).href;
  const normalizerModule: unknown = await import(normalizerUrl);
  if (!isRecord(normalizerModule) || typeof normalizerModule.default !== "function") {
    throw new TypeError("The pinned semantic-release plugin normalizer must export a default function.");
  }
  const logger: FixtureLogger = {
    scopeName: "release-smoke",
    scope: () => logger,
    log: () => undefined,
    success: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const normalizePlugin = normalizerModule.default as NormalizePlugin;
  const plugin = await normalizePlugin({
    cwd: root,
    stdout: process.stdout,
    stderr: process.stderr,
    options: { dryRun: false },
    logger,
  }, "prepare", preparePlugin, {});
  await plugin({
    cwd: source,
    nextRelease: { version: nextVersion },
    options: { dryRun: false },
    stdout: process.stdout,
    stderr: process.stderr,
    logger,
  });

  const archive = join(source, ".release-artifacts", `codex-permission-reviewer-${nextVersion}.tgz`);
  await access(archive);
  const packageManifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { version: string };
  const pluginManifest = JSON.parse(await readFile(join(source, ".codex-plugin/plugin.json"), "utf8")) as { version: string };
  const runtimeVersion = await readFile(join(source, "dist/src/version.js"), "utf8");
  assert.equal(packageManifest.version, nextVersion);
  assert.equal(pluginManifest.version, nextVersion);
  assert.match(runtimeVersion, new RegExp(`PACKAGE_VERSION = [\"']${nextVersion.replaceAll(".", "\\.")}[\"']`, "u"));

  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "reviewer-release-archive-fixture",
    version: "1.0.0",
    private: true,
  }));
  run("npm", [
    "install", "--prefix", consumer, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", archive,
  ], { env: environment });
  const installed = join(consumer, "node_modules", "codex-permission-reviewer");
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    version: string;
  };
  assert.equal(installedManifest.version, nextVersion);
  await assert.rejects(access(join(installed, ".github", "release")), { code: "ENOENT" });

  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "versioned-archive-fixture", version: "1.0.0" },
    },
  };
  const cli = join(installed, installedManifest.bin["codex-permission-reviewer"]!);
  const reply = JSON.parse(run(process.execPath, [cli, "mcp"], {
    cwd: consumer,
    input: `${JSON.stringify(request)}\n`,
    env: environment,
  }).trim()) as { result?: { serverInfo?: { version?: string } } };
  assert.equal(reply.result?.serverInfo?.version, nextVersion);
  process.stdout.write(`Release prepare smoke: ${nextVersion} source metadata, archive and MCP runtime versions agree.\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
