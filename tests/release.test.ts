import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { synchronizeReleaseMetadata } from "../.github/release/prepare.ts";
import { PACKAGE_VERSION } from "../src/version.ts";

const PACKAGE_NAME = "codex-permission-reviewer";
const REPOSITORY_OWNER = "adriancho91s";
const NEXT_TEST_VERSION = (() => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(PACKAGE_VERSION);
  assert.ok(match, "shared package version must have a semantic-version core");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
})();

async function makeMetadataFixture(options: {
  lockVersion?: string;
  lockRootName?: string;
  pluginVersion?: string;
  pluginName?: string;
} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reviewer-release-metadata-"));
  await mkdir(join(root, ".codex-plugin"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: PACKAGE_NAME, version: PACKAGE_VERSION }, null, 2)}\n`);
  await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
    name: PACKAGE_NAME,
    version: options.lockVersion ?? PACKAGE_VERSION,
    lockfileVersion: 3,
    packages: { "": { name: options.lockRootName ?? PACKAGE_NAME, version: PACKAGE_VERSION } },
  }, null, 2)}\n`);
  await writeFile(join(root, ".codex-plugin/plugin.json"), `${JSON.stringify({ name: options.pluginName ?? PACKAGE_NAME, version: options.pluginVersion ?? PACKAGE_VERSION }, null, 2)}\n`);
  await writeFile(join(root, "src/version.ts"), `/** Shared package version. */\nexport const PACKAGE_VERSION = "${PACKAGE_VERSION}";\n`);
  await writeFile(join(root, "README.md"), [
    `github:${REPOSITORY_OWNER}/${PACKAGE_NAME}#v${PACKAGE_VERSION} install`,
    `github:${REPOSITORY_OWNER}/${PACKAGE_NAME}#v${PACKAGE_VERSION} mcp`,
    `github:${REPOSITORY_OWNER}/${PACKAGE_NAME}#v${PACKAGE_VERSION} install --force`,
    `github:${REPOSITORY_OWNER}/${PACKAGE_NAME}#v${PACKAGE_VERSION} upgrade`,
  ].join("\n"));
  return root;
}

test("release preparation synchronizes the source-install and archive version contract", async () => {
  const root = await makeMetadataFixture();
  try {
    await synchronizeReleaseMetadata(root, NEXT_TEST_VERSION);
    const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const packageLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    const pluginManifest = JSON.parse(await readFile(join(root, ".codex-plugin/plugin.json"), "utf8")) as { version: string };
    const sourceVersion = await readFile(join(root, "src/version.ts"), "utf8");
    const readme = await readFile(join(root, "README.md"), "utf8");

    assert.equal(packageJson.version, NEXT_TEST_VERSION);
    assert.equal(packageLock.version, NEXT_TEST_VERSION);
    assert.equal(packageLock.packages[""]?.version, NEXT_TEST_VERSION);
    assert.equal(pluginManifest.version, NEXT_TEST_VERSION);
    assert.ok(sourceVersion.includes(`PACKAGE_VERSION = "${NEXT_TEST_VERSION}"`));
    assert.equal([...readme.matchAll(new RegExp(`#v${NEXT_TEST_VERSION.replaceAll(".", "\\.")}`, "gu"))].length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release preparation refuses drift before changing any version file", async () => {
  const root = await makeMetadataFixture({ lockVersion: NEXT_TEST_VERSION });
  try {
    const packageBefore = await readFile(join(root, "package.json"), "utf8");
    const sourceBefore = await readFile(join(root, "src/version.ts"), "utf8");
    const readmeBefore = await readFile(join(root, "README.md"), "utf8");
    await assert.rejects(synchronizeReleaseMetadata(root, NEXT_TEST_VERSION), /does not match/u);
    assert.equal(await readFile(join(root, "package.json"), "utf8"), packageBefore);
    assert.equal(await readFile(join(root, "src/version.ts"), "utf8"), sourceBefore);
    assert.equal(await readFile(join(root, "README.md"), "utf8"), readmeBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release preparation rejects mismatched distribution identities before changing files", async () => {
  for (const options of [{ pluginName: "unexpected-plugin" }, { lockRootName: "unexpected-package" }]) {
    const root = await makeMetadataFixture(options);
    try {
      const paths = ["package.json", "package-lock.json", ".codex-plugin/plugin.json", "src/version.ts", "README.md"];
      const before = await Promise.all(paths.map(path => readFile(join(root, path), "utf8")));
      await assert.rejects(synchronizeReleaseMetadata(root, NEXT_TEST_VERSION), /must describe/u);
      const after = await Promise.all(paths.map(path => readFile(join(root, path), "utf8")));
      assert.deepEqual(after, before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("release preparation rejects an invalid version before reading release files", async () => {
  await assert.rejects(synchronizeReleaseMetadata(tmpdir(), "../" + NEXT_TEST_VERSION), /valid semantic version/u);
});

test("checked-in release metadata agrees with the shared runtime version", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
  const packageLock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
    version: string;
    packages: Record<string, { version: string }>;
  };
  const pluginManifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8")) as { version: string };
  const readme = await readFile("README.md", "utf8");
  const pinnedVersions = [...readme.matchAll(/github:adriancho91s\/codex-permission-reviewer#v([^\s`]+)/gu)];

  assert.equal(packageJson.version, PACKAGE_VERSION);
  assert.equal(packageLock.version, PACKAGE_VERSION);
  assert.equal(packageLock.packages[""]?.version, PACKAGE_VERSION);
  assert.equal(pluginManifest.version, PACKAGE_VERSION);
  assert.equal(pinnedVersions.length, 3);
  assert.ok(pinnedVersions.every(match => match[1] === PACKAGE_VERSION));
});

test("release tooling stays isolated and GitHub-only with no issue or registry writes", async () => {
  const application = JSON.parse(await readFile("package.json", "utf8")) as {
    engines: { node: string };
    devDependencies: Record<string, string>;
    publishConfig?: unknown;
  };
  const releaseTools = JSON.parse(await readFile(".github/release/package.json", "utf8")) as {
    engines: { node: string };
    devDependencies: Record<string, string>;
  };
  const config = JSON.parse(await readFile(".releaserc.json", "utf8")) as {
    branches: string[];
    tagFormat: string;
    plugins: (string | [string, Record<string, unknown>])[];
  };
  const pluginNames = config.plugins.map(plugin => typeof plugin === "string" ? plugin : plugin[0]);
  const analyzer = config.plugins.find(plugin => typeof plugin !== "string" && plugin[0].endsWith("/@semantic-release/commit-analyzer"));
  const notesGenerator = config.plugins.find(plugin => typeof plugin !== "string" && plugin[0].endsWith("/@semantic-release/release-notes-generator"));
  const githubPlugin = config.plugins.find(plugin => typeof plugin !== "string" && plugin[0].endsWith("/@semantic-release/github"));
  assert.ok(Array.isArray(analyzer));
  assert.ok(Array.isArray(notesGenerator));
  assert.ok(Array.isArray(githubPlugin));
  assert.equal(analyzer[1].preset, "conventionalcommits");
  assert.equal(notesGenerator[1].preset, "conventionalcommits");
  const githubOptions = githubPlugin[1];

  assert.equal(application.engines.node, ">=20");
  assert.equal(application.publishConfig, undefined);
  assert.ok(!Object.keys(application.devDependencies).some(name => name.includes("semantic-release")));
  assert.equal(releaseTools.engines.node, ">=24.15.0");
  assert.deepEqual(config.branches, ["main"]);
  assert.equal(config.tagFormat, "v${version}");
  assert.ok(!pluginNames.some(name => name.includes("@semantic-release/npm")));
  for (const key of ["successComment", "successCommentCondition", "failComment", "failCommentCondition", "labels", "releasedLabels", "addReleases", "discussionCategoryName"]) {
    assert.equal(githubOptions[key], false, `GitHub release option ${key} must not write issues, PRs or discussions`);
  }
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const windowsStart = workflow.indexOf("  windows-approval-memory:\n");
  const validationStart = workflow.indexOf("  release-validation:\n");
  const releaseStart = workflow.indexOf("  release:\n", validationStart);
  assert.ok(windowsStart >= 0 && windowsStart < validationStart, "Windows approval-memory validation must be a separate CI job");
  assert.ok(validationStart >= 0 && releaseStart > validationStart, "release validation must be a separate CI job");
  const windowsJob = workflow.slice(windowsStart, validationStart);
  assert.match(windowsJob, /runs-on: windows-latest\n/u);
  assert.match(windowsJob, /permissions:\n      contents: read\n/u);
  assert.match(windowsJob, /node-version: 20\.x\n/u);
  assert.match(windowsJob, /npm ci --ignore-scripts/u);
  assert.match(windowsJob, /npm run build/u);
  assert.match(windowsJob, /node --test dist\/tests\/approval-memory\.test\.js/u);
  assert.match(windowsJob, /persist-credentials: false/u);
  const validationJob = workflow.slice(validationStart, releaseStart);
  assert.match(validationJob, /needs: test\n/u);
  assert.match(validationJob, /permissions:\n      contents: read\n/u);
  assert.match(validationJob, /persist-credentials: false/u);
  assert.ok(!/GITHUB_TOKEN|secrets\./u.test(validationJob), "release validation must not receive a publishing token");
  const toolingInstall = validationJob.indexOf("npm ci --prefix .github/release");
  const prepareSmoke = validationJob.indexOf("verify-prepare-smoke.js");
  assert.ok(toolingInstall >= 0 && prepareSmoke > toolingInstall, "prepare smoke must use the pinned release tooling");
  assert.match(workflow.slice(releaseStart), /needs: \[test, windows-approval-memory, release-validation\]/u);
  assert.match(workflow, /fetch-depth: 0\s+persist-credentials: false/u);
  assert.match(workflow, /GIT_ASKPASS=/u);
  assert.match(workflow, /GIT_TERMINAL_PROMPT=0/u);
  assert.equal([...workflow.matchAll(/GITHUB_TOKEN:/gu)].length, 1, "the token belongs only to the final release step");
});
