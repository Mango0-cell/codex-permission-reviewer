import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface PluginOptions {
  [key: string]: unknown;
}

interface PluginContext {
  cwd: string;
  commits: { hash: string; message: string }[];
  logger: { log: (...values: unknown[]) => void };
}

interface ReleaseNotesContext extends PluginContext {
  lastRelease: { gitTag: string; gitHead: string };
  nextRelease: { version: string; gitTag: string; gitHead: string };
  options: { repositoryUrl: string };
}

interface JsonObject {
  [key: string]: unknown;
}

type PluginEntry = string | [string, PluginOptions];
type AnalyzeCommits = (options: PluginOptions, context: PluginContext) => Promise<string | null>;
type GenerateNotes = (options: PluginOptions, context: ReleaseNotesContext) => Promise<string>;

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `${command} ${args.join(" ")} failed`);
  return result.stdout;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginParts(entry: PluginEntry): { path: string; options: PluginOptions } {
  return typeof entry === "string" ? { path: entry, options: {} } : { path: entry[0], options: entry[1] };
}

async function pluginModuleUrl(path: string): Promise<string> {
  const target = resolve(root, path);
  if (!(await stat(target)).isDirectory()) return pathToFileURL(target).href;
  const packagePath = join(target, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as JsonObject;
  const entry = typeof packageJson.exports === "string" ? packageJson.exports : packageJson.main;
  if (typeof entry !== "string") throw new TypeError(`${path}/package.json must declare an exported entrypoint.`);
  return pathToFileURL(resolve(dirname(packagePath), entry)).href;
}

function namedFunction<FunctionType extends (...args: never[]) => unknown>(module: unknown, name: string): FunctionType {
  if (!isJsonObject(module) || typeof module[name] !== "function") {
    throw new TypeError(`Configured release plugin must export ${name}().`);
  }
  return module[name] as FunctionType;
}

const root = resolve(process.cwd());
const config = JSON.parse(await readFile(resolve(root, ".releaserc.json"), "utf8")) as {
  plugins: PluginEntry[];
};
const loaded = new Map<string, { options: PluginOptions; module: unknown }>();
for (const entry of config.plugins) {
  const parts = pluginParts(entry);
  const pluginModule: unknown = await import(await pluginModuleUrl(parts.path));
  loaded.set(parts.path, { options: parts.options, module: pluginModule });
}

const analyzerEntry = [...loaded.entries()].find(([path]) => path.endsWith("/@semantic-release/commit-analyzer"));
const notesEntry = [...loaded.entries()].find(([path]) => path.endsWith("/@semantic-release/release-notes-generator"));
assert.ok(analyzerEntry, "the configured commit analyzer must load");
assert.ok(notesEntry, "the configured release-notes generator must load");
assert.ok([...loaded.keys()].some(path => path.endsWith("/.github/release/prepare.js")), "the typed preparation hook must load");
assert.ok([...loaded.keys()].some(path => path.endsWith("/@semantic-release/git")), "the metadata commit plugin must load");
assert.ok([...loaded.keys()].some(path => path.endsWith("/@semantic-release/github")), "the GitHub release plugin must load");

const analyzeCommits = namedFunction<AnalyzeCommits>(analyzerEntry[1].module, "analyzeCommits");
const generateNotes = namedFunction<GenerateNotes>(notesEntry[1].module, "generateNotes");
assert.equal(analyzerEntry[1].options.preset, "conventionalcommits");
assert.equal(notesEntry[1].options.preset, "conventionalcommits");

const examples: { message: string; release: string | null }[] = [
  { message: "feat!: break the public API", release: "major" },
  { message: "fix(api): change an incompatible response\n\nBREAKING CHANGE: callers must use the new field", release: "major" },
  { message: "feat(policy): add exact review detail", release: "minor" },
  { message: "fix(runtime): preserve child cleanup", release: "patch" },
  { message: "perf(review): reduce repeated model calls", release: "patch" },
  { message: "docs: clarify an existing contract", release: null },
  { message: "refactor(review): simplify private scheduling", release: null },
];
for (const [index, example] of examples.entries()) {
  const release = await analyzeCommits(analyzerEntry[1].options, {
    cwd: root,
    commits: [{ hash: `fixture-${index}`, message: example.message }],
    logger: { log: () => undefined },
  });
  assert.equal(release, example.release, `unexpected release impact for ${example.message}`);
}

const breakingMessage = `${examples[0]!.message}\n\nBREAKING CHANGE: callers must use the new method`;
const notes = await generateNotes(notesEntry[1].options, {
  cwd: root,
  commits: [{ hash: "fixture-breaking", message: breakingMessage }],
  logger: { log: () => undefined },
  lastRelease: { gitTag: "v0.3.0", gitHead: "previous" },
  nextRelease: { version: "1.0.0", gitTag: "v1.0.0", gitHead: "current" },
  options: { repositoryUrl: "https://github.com/adriancho91s/codex-permission-reviewer.git" },
});
assert.match(notes, /BREAKING CHANGES/u);

const temporary = await mkdtemp(join(tmpdir(), "reviewer-release-dry-run-"));
const fixture = join(temporary, "work");
const bareRemote = join(temporary, "origin.git");
try {
  await mkdir(fixture);
  run("git", ["init", "--bare", "--initial-branch=main", bareRemote]);
  run("git", ["init", "--initial-branch=main", fixture]);
  run("git", ["-C", fixture, "config", "user.name", "Release Fixture"]);
  run("git", ["-C", fixture, "config", "user.email", "release-fixture@example.invalid"]);
  const repositoryUrl = "https://github.com/adriancho91s/codex-permission-reviewer.git";
  run("git", ["-C", fixture, "config", `url.${pathToFileURL(bareRemote).href}.insteadOf`, repositoryUrl]);
  await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "release-fixture", version: "0.3.0" }, null, 2));
  await writeFile(join(fixture, "README.md"), "Disposable release fixture.\n");
  run("git", ["-C", fixture, "add", "package.json", "README.md"]);
  run("git", ["-C", fixture, "commit", "-m", "chore: seed disposable release fixture"]);
  run("git", ["-C", fixture, "tag", "v0.3.0"]);
  run("git", ["-C", fixture, "remote", "add", "origin", bareRemote]);
  await writeFile(join(fixture, "README.md"), "Disposable release fixture with a breaking change.\n");
  run("git", [
    "-C", fixture, "add", "README.md",
  ]);
  run("git", [
    "-C", fixture, "commit", "-m", "feat!: exercise the isolated dry run", "-m", "BREAKING CHANGE: use the new release fixture contract",
  ]);
  run("git", ["-C", fixture, "push", "--quiet", "origin", "main", "--tags"]);

  const localConfig = {
    branches: ["main"],
    tagFormat: "v${version}",
    repositoryUrl,
    plugins: [
      [resolve(root, ".github/release/node_modules/@semantic-release/commit-analyzer"), { preset: "conventionalcommits" }],
      [resolve(root, ".github/release/node_modules/@semantic-release/release-notes-generator"), { preset: "conventionalcommits" }],
    ],
  };
  await writeFile(join(fixture, ".releaserc.json"), `${JSON.stringify(localConfig, null, 2)}\n`);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/(?:TOKEN|PASSWORD|AUTH|SECRET|CREDENTIAL|PRIVATE_KEY)/iu.test(key)) delete environment[key];
  }
  environment.NPM_CONFIG_USERCONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
  const dryRunOutput = run(process.execPath, [
    resolve(root, ".github/release/node_modules/semantic-release/bin/semantic-release.js"),
    "--dry-run", "--no-ci",
  ], { cwd: fixture, env: environment });
  assert.match(dryRunOutput, /next release version is 1\.0\.0/iu);
  assert.match(dryRunOutput, /BREAKING CHANGE/iu);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("Release tooling: configured plugins load; commit mapping, breaking notes and a local bare-Git semantic-release dry run passed.\n");
