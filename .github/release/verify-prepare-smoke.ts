import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PACKAGE_VERSION } from "../../src/version.js";

interface PrepareContext {
  cwd: string;
  nextRelease: { version: string };
}

type PrepareHook = (context: PrepareContext) => Promise<void>;

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

  const hookModule: unknown = await import(resolve(root, "dist/.github/release/prepare.js"));
  if (!isRecord(hookModule) || typeof hookModule.prepare !== "function") {
    throw new TypeError("The built release preparation hook must export prepare().");
  }
  const prepare = hookModule.prepare as PrepareHook;
  await prepare({ cwd: source, nextRelease: { version: nextVersion } });

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
      protocolVersion: "2025-03-26",
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
