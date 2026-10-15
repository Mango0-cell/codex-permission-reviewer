#!/usr/bin/env node
import type { SpawnSyncOptions } from "node:child_process";

import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "codex-permission-reviewer";
const PACKAGE_VERSION = "0.3.0";
const REMOTE_PACKAGE = `github:adriancho91s/${PACKAGE_NAME}#v${PACKAGE_VERSION}`;
const MCP_NAME = PACKAGE_NAME;
const MODEL_ENV = "CODEX_PERMISSION_REVIEW_MODEL";
const EFFORT_ENV = "CODEX_PERMISSION_REVIEW_EFFORT";
const DEFAULT_MODEL = "gpt-5.6-luna";
const DEFAULT_EFFORT = "max";

function run(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function codexHome() {
  const configured = process.env.CODEX_HOME;
  if (typeof configured === "string" && configured.length > 0) {
    if (!isAbsolute(configured)) throw new Error("CODEX_HOME must be an absolute path.");
    return configured;
  }
  return join(homedir(), ".codex");
}

async function installSkill(force: boolean) {
  const source = fileURLToPath(new URL("../../skills/sensitive-permission-review/SKILL.md", import.meta.url));
  const destination = join(codexHome(), "skills", "sensitive-permission-review", "SKILL.md");
  let existing = null;
  try {
    existing = await readFile(destination, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const bundled = await readFile(source, "utf8");
  if (existing !== null && existing !== bundled && !force) {
    throw new Error(`Refusing to overwrite ${destination}; rerun with --force after reviewing the difference.`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
}

async function install() {
  const force = process.argv.includes("--force");
  const modelIndex = process.argv.indexOf("--model");
  const effortIndex = process.argv.indexOf("--effort");
  const model = modelIndex === -1 ? DEFAULT_MODEL : process.argv[modelIndex + 1];
  const effort = effortIndex === -1 ? DEFAULT_EFFORT : process.argv[effortIndex + 1];
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) {
    throw new Error("--model requires a valid Codex model identifier.");
  }
  if (typeof effort !== "string" || !["low", "medium", "high", "max"].includes(effort)) {
    throw new Error("--effort must be low, medium, high, or max.");
  }
  await installSkill(force);
  if (force) run("codex", ["mcp", "remove", MCP_NAME]);
  const status = run("codex", [
    "mcp",
    "add",
    "--env",
    `${MODEL_ENV}=${model}`,
    "--env",
    `${EFFORT_ENV}=${effort}`,
    MCP_NAME,
    "--",
    "npx",
    "-y",
    REMOTE_PACKAGE,
    "mcp",
  ]);
  if (status !== 0) throw new Error("Codex MCP registration failed.");
  process.stdout.write(`Installed ${PACKAGE_NAME}. Start a new Codex thread to load the skill and MCP schema.\n`);
}

function runMcp() {
  const server = fileURLToPath(new URL("../scripts/server.js", import.meta.url));
  process.exitCode = run(process.execPath, [server]);
}

function printHelp() {
  process.stdout.write(`Usage:\n  ${PACKAGE_NAME} install [--force] [--model MODEL] [--effort low|medium|high|max]\n  ${PACKAGE_NAME} mcp\n`);
}

const command = process.argv[2] ?? "install";
try {
  if (command === "install") await install();
  else if (command === "mcp") runMcp();
  else if (command === "help" || command === "--help" || command === "-h") printHelp();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Installation failed."}\n`);
  process.exitCode = 1;
}
