import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import * as legacy from '../scripts/server.mjs';
import * as legacyClient from '../scripts/app-server-client.mjs';
import * as client from '../src/runtime/app-server-client.mjs';
import { reviewSensitiveAction } from '../src/review/service.mjs';

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}

test('runtime domain dependencies are acyclic and stay inside declared boundaries', async () => {
  const allowed = {
    config: ['runtime/config.mjs'], action: ['config', 'action'],
    approvals: ['config', 'action'], policy: ['config', 'action', 'policy'],
    review: ['config', 'action', 'approvals', 'policy', 'review', 'runtime'],
    runtime: ['runtime'], transport: ['config', 'action', 'review', 'transport'],
  };
  const graph = new Map();
  for (const path of (await files('src')).filter(path => path.endsWith('.mjs'))) {
    const domain = path === 'src/config.mjs' ? 'config' : path.split('/')[1];
    const imports = [...(await readFile(path, 'utf8')).matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)].map(match => match[1]);
    const edges = [];
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('.'), `${path}: unexpected external dependency ${specifier}`);
      const target = relative(process.cwd(), resolve(dirname(path), specifier));
      const targetDomain = target === 'src/config.mjs' ? 'config' : target.split('/')[1];
      assert.ok(allowed[domain].includes(targetDomain) || (domain === 'config' && target === 'src/runtime/config.mjs'), `${path} cannot depend on ${target}`);
      edges.push(target);
    }
    graph.set(path, edges);
  }
  const visiting = new Set(), visited = new Set();
  function visit(path) {
    assert.ok(!visiting.has(path), `cyclic dependency at ${path}`);
    if (visited.has(path)) return;
    visiting.add(path);
    for (const edge of graph.get(path) ?? []) visit(edge);
    visiting.delete(path); visited.add(path);
  }
  for (const path of graph.keys()) visit(path);
});

test('every maintained domain and subdirectory has an AGENTS.md specification', async () => {
  const roots = ['src', 'bin', 'scripts', 'skills', 'tests', 'docs', '.github', '.codex-plugin'];
  for (const root of roots) {
    const directories = new Set([root, ...(await files(root)).map(dirname)]);
    for (const directory of directories) await access(`${directory}/AGENTS.md`);
  }
});

test('legacy launcher exports remain available and point to production implementations', () => {
  const expected = ['DEFAULT_REVIEW_TIMEOUT_MS','LEARNED_APPROVAL_TTL_MS','MAX_CONCURRENT_REVIEWS','MAX_OUTPUT_BYTES','MAX_OUTPUT_TOKENS','MAX_PROMPT_CHARS','MAX_REQUEST_BYTES','MAX_REVIEW_CACHE_ENTRIES','MAX_REVIEW_TIMEOUT_MS','MCP_PROTOCOL_VERSION','OPERATION_KINDS','REVERSIBILITY_VALUES','REVIEW_MODEL','REVIEW_RATE_LIMIT_MAX_CALLS','REVIEW_RATE_LIMIT_WINDOW_MS','REVIEW_REASONING_EFFORT','REVIEW_RESPONSE_SCHEMA','REVIEW_TTL_MS','SUPPORTED_MCP_PROTOCOL_VERSIONS','TOOL_DEFINITION','TOOL_NAME','TRUSTED_ROOTS_ENV','USER_AUTHORIZATION_VALUES','buildReviewerPrompt','parseReviewerOutput','readBoundedLines','reviewSensitiveAction','runPermissionReviewer','sameFileIdentity','validateProposedAction','verifySafeRead'];
  assert.deepEqual(Object.keys(legacy).sort(), expected.sort());
  assert.equal(legacy.reviewSensitiveAction, reviewSensitiveAction);
  assert.deepEqual(legacyClient, client);
});

test('npm distribution contains every runtime module and stable launcher', async () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  const paths = new Set(pack.files.map(file => file.path));
  for (const path of (await files('src')).filter(path => path.endsWith('.mjs'))) assert.ok(paths.has(path), `missing packaged module ${path}`);
  for (const path of ['scripts/server.mjs', 'scripts/app-server-client.mjs', 'bin/cli.mjs', 'skills/sensitive-permission-review/SKILL.md', '.mcp.json', '.codex-plugin/plugin.json']) assert.ok(paths.has(path), `missing entrypoint ${path}`);
  assert.ok(![...paths].some(path => path.startsWith('graphify-out/')));
});
