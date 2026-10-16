import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MCP_PROTOCOL_VERSION } from "../../src/config.ts";
import { PACKAGE_VERSION } from "../../src/version.ts";

function run(command: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `${command} failed`);
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

const temporary = await mkdtemp(join(tmpdir(), "reviewer-source-install-"));
const sourceCheckout = join(temporary, "source");
const bareRepository = join(temporary, "source.git");
const consumer = join(temporary, "consumer");
const environment = isolatedNpmEnvironment();

try {
  run("git", ["clone", "--quiet", "--no-hardlinks", process.cwd(), sourceCheckout]);
  run("git", ["clone", "--quiet", "--bare", sourceCheckout, bareRepository]);
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "reviewer-source-install-fixture",
    version: "1.0.0",
    private: true,
  }));
  const commit = run("git", ["-C", sourceCheckout, "rev-parse", "HEAD"]).trim();
  const sourceSpecifier = `git+${pathToFileURL(bareRepository).href}#${commit}`;
  run("npm", [
    "install", "--prefix", consumer, "--no-audit", "--no-fund", "--no-save", "--no-package-lock", sourceSpecifier,
  ], { env: environment });

  const installed = join(consumer, "node_modules", "codex-permission-reviewer");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as {
    bin: Record<string, string>;
    version: string;
  };
  assert.equal(manifest.version, PACKAGE_VERSION);
  await access(join(installed, "dist", "src", "transport", "mcp.js"));
  await assert.rejects(access(join(installed, ".github", "release")), { code: "ENOENT" });

  const cli = join(installed, manifest.bin["codex-permission-reviewer"]!);
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "source-install-fixture", version: "1.0.0" },
    },
  };
  const responseText = run(process.execPath, [cli, "mcp"], {
    cwd: consumer,
    input: `${JSON.stringify(initialize)}\n`,
    env: environment,
  });
  const response = JSON.parse(responseText.trim()) as {
    result?: { serverInfo?: { name?: string; version?: string } };
  };
  assert.equal(response.result?.serverInfo?.name, "codex-permission-reviewer");
  assert.equal(response.result?.serverInfo?.version, PACKAGE_VERSION);
  process.stdout.write("Source Git install: npm prepare built the Node runtime without installing release tooling.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
