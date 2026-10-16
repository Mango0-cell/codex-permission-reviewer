import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, access, lstat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import * as legacy from '../scripts/server.js';
import * as legacyClient from '../scripts/app-server-client.js';
import * as client from '../src/runtime/app-server-client.js';
import { reviewSensitiveAction } from '../src/review/service.js';

async function files(directory: string): Promise<string[]> {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}

test('runtime domain dependencies are acyclic and stay inside declared boundaries', async () => {
  const allowed: Record<string, string[]> = {
    config: ['runtime/config.ts'], action: ['config', 'action'],
    approvals: ['config', 'action'], policy: ['config', 'action', 'policy'],
    review: ['config', 'action', 'approvals', 'policy', 'review', 'runtime'],
    runtime: ['runtime'], transport: ['config', 'action', 'review', 'transport'],
  };
  const graph = new Map<string, string[]>();
  for (const path of (await files('src')).filter(path => path.endsWith('.ts'))) {
    const domain = path === 'src/config.ts' ? 'config' : path.split('/')[1]!;
    const imports = [...(await readFile(path, 'utf8')).matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)].map(match => match[1]!);
    const edges = [];
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `${path}: unexpected external dependency ${specifier}`);
      const target = relative(process.cwd(), resolve(dirname(path), specifier)).replace(/\.js$/u, '.ts');
      const targetDomain = target === 'src/config.ts' ? 'config' : target.split('/')[1]!;
      assert.ok(allowed[domain]!.includes(targetDomain) || (domain === 'config' && target === 'src/runtime/config.ts'), `${path} cannot depend on ${target}`);
      edges.push(target);
    }
    graph.set(path, edges);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(path: string) {
    assert.ok(!visiting.has(path), `cyclic dependency at ${path}`);
    if (visited.has(path)) return;
    visiting.add(path);
    for (const edge of graph.get(path) ?? []) visit(edge);
    visiting.delete(path); visited.add(path);
  }
  for (const path of graph.keys()) visit(path);
});

test('every maintained domain and subdirectory has an AGENTS.md specification', async () => {
  assert.equal((await readFile('CLAUDE.md', 'utf8')).trim(), '@AGENTS.md');
  const roots = ['src', 'bin', 'scripts', 'skills', 'tests', 'docs', '.github', '.codex-plugin'];
  for (const root of roots) {
    const directories = new Set([root, ...(await files(root)).map(dirname)]);
    for (const directory of directories) {
      await access(`${directory}/AGENTS.md`);
      assert.equal((await readFile(`${directory}/CLAUDE.md`, 'utf8')).trim(), '@AGENTS.md');
    }
  }
});

test('native agent setup trees use skills and rules without nested specs', async () => {
  for (const root of ['.agents', '.claude']) {
    const specs = (await files(root)).filter(path => path.endsWith('/AGENTS.md') || path.endsWith('/CLAUDE.md'));
    assert.deepEqual(specs, [], `${root} should use provider-native instruction files`);
  }
});

test('legacy launcher exports remain available and point to production implementations', () => {
  const expected = ['DEFAULT_REVIEW_TIMEOUT_MS','LEARNED_APPROVAL_TTL_MS','MAX_CONCURRENT_REVIEWS','MAX_OUTPUT_BYTES','MAX_OUTPUT_TOKENS','MAX_PROMPT_CHARS','MAX_REQUEST_BYTES','MAX_REVIEW_CACHE_ENTRIES','MAX_REVIEW_TIMEOUT_MS','MCP_PROTOCOL_VERSION','OPERATION_KINDS','REVERSIBILITY_VALUES','REVIEW_MODEL','REVIEW_RATE_LIMIT_MAX_CALLS','REVIEW_RATE_LIMIT_WINDOW_MS','REVIEW_REASONING_EFFORT','REVIEW_RESPONSE_SCHEMA','REVIEW_TTL_MS','SUPPORTED_MCP_PROTOCOL_VERSIONS','TOOL_DEFINITION','TOOL_NAME','TRUSTED_ROOTS_ENV','USER_AUTHORIZATION_VALUES','buildReviewerPrompt','parseReviewerOutput','readBoundedLines','reviewSensitiveAction','runPermissionReviewer','sameFileIdentity','validateProposedAction','verifySafeRead'];
  assert.deepEqual(Object.keys(legacy).sort(), expected.sort());
  assert.equal(legacy.reviewSensitiveAction, reviewSensitiveAction);
  assert.deepEqual(legacyClient, client);
});

test('npm distribution contains built modules, declarations and generated compatibility launchers', async () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' })) as [{ files: { path: string }[] }];
  const paths = new Set(pack.files.map(file => file.path));
  for (const path of (await files('src')).filter(path => path.endsWith('.ts'))) {
    const emitted = `dist/${path.replace(/\.ts$/u, '.js')}`;
    assert.ok(paths.has(emitted), `missing packaged runtime ${emitted}`);
    assert.ok(paths.has(emitted.replace(/\.js$/u, '.d.ts')), `missing declarations ${emitted}`);
  }
  for (const path of ['scripts/server.mjs', 'scripts/app-server-client.mjs', 'bin/cli.mjs', 'skills/sensitive-permission-review/SKILL.md', '.mcp.json', '.codex-plugin/plugin.json']) assert.ok(paths.has(path), `missing entrypoint ${path}`);
  assert.ok(![...paths].some(path => path.startsWith('graphify-out/') || path.startsWith('dist/tests/')));
  assert.ok(![...paths].some(path => /^(src|tests|bin|scripts)\/.*\.ts$/u.test(path)));
});

test('maintained source uses TypeScript and JavaScript launchers are generated', async () => {
  for (const directory of ['src', 'tests']) {
    assert.ok(!(await files(directory)).some(path => /\.(?:mjs|cjs|js)$/u.test(path)));
  }
  for (const path of ['bin/cli.mjs', 'scripts/server.mjs', 'scripts/app-server-client.mjs']) {
    assert.match(await readFile(path, 'utf8'), /Generated by the TypeScript build/u);
  }
});

test('Codex and Claude have native skill folders with frontmatter and shared-guide routes', async () => {
  const expectedGuides: Record<string, string> = {
    architecture: 'architecture', commit: 'commits', policy: 'policy', pr: 'pull-requests', runtime: 'runtime',
  };
  for (const providerRoot of ['.agents/skills', '.claude/skills']) {
    const names = (await readdir(providerRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert.deepEqual(names, Object.keys(expectedGuides).sort(), `${providerRoot} skill names`);
    for (const [name, guide] of Object.entries(expectedGuides)) {
      const directory = `${providerRoot}/${name}`;
      const skillPath = `${directory}/SKILL.md`;
      const directoryStat = await lstat(directory);
      const skillStat = await lstat(skillPath);
      assert.equal(directoryStat.isDirectory(), true, `${directory} must be a real directory`);
      assert.equal(directoryStat.isSymbolicLink(), false, `${directory} must not be a directory symlink`);
      assert.equal(skillStat.isFile(), true, `${skillPath} must be a regular file`);
      assert.equal(skillStat.isSymbolicLink(), false, `${skillPath} must not be a symlink`);

      const content = await readFile(skillPath, 'utf8');
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
      assert.ok(frontmatter, `${skillPath} needs YAML frontmatter`);
      assert.match(frontmatter!, new RegExp(`^name: ${name}$`, 'mu'));
      assert.match(frontmatter!, /^description:\s*\S.+$/mu);
      const guideLink = `../../../docs/maintainers/${guide}.md`;
      const links = [...content.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]);
      assert.ok(links.includes(guideLink), `${skillPath} must route to ${guideLink}`);
      await access(resolve(directory, guideLink));
    }
  }
});
