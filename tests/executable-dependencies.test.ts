import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { action, allow } from './helpers.ts';
import { actionSha256, validateProposedAction } from '../src/action/metadata.ts';
import { createReviewService } from '../src/review/service.ts';
import type { ActionInput } from '../src/action/types.ts';

const dependencyVerificationUnsupported = process.platform === 'win32';

interface Fixture {
  temporaryHome: string;
  home: string;
  dependencyPath: string;
  manifestPath: string;
  contents: string;
  request: ActionInput & Record<string, unknown>;
  writeManifest(dependencies?: Array<{ path: string; sha256: string }>, additions?: Record<string, unknown>, reviewedAction?: ActionInput & Record<string, unknown>): Promise<void>;
  writeRawManifest(value: unknown): Promise<void>;
  cleanup(): Promise<void>;
}

async function fixture(options: { additionalTargets?: string[]; writeManifest?: boolean } = {}): Promise<Fixture> {
  const temporaryHome = await mkdtemp(join(tmpdir(), 'cpr-executable-dependency-'));
  const home = await realpath(temporaryHome);
  const dependencyPath = join(home, 'workspace', 'node_modules', 'reviewed-package', 'index.js');
  const contents = 'export const fixtureCodeThatMustNeverReachTheModel = true;\n';
  const request = action({
    operationKind: 'command',
    command: `node ${dependencyPath}`,
    cwd: join(home, 'workspace'),
    workspaceRoots: [join(home, 'workspace')],
    fileTargets: [dependencyPath, ...(options.additionalTargets ?? [])],
    userAuthorization: 'explicit',
  });
  await mkdir(dirname(dependencyPath), { recursive: true, mode: 0o700 });
  await writeFile(dependencyPath, contents, { mode: 0o600 });
  const stateDirectory = join(home, 'plugin-state', 'codex-permission-reviewer');
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = join(stateDirectory, 'executable-dependencies.json');
  const writeManifest = async (dependencies = [{ path: dependencyPath, sha256: createHash('sha256').update(contents).digest('hex') }], additions: Record<string, unknown> = {}, reviewedAction = request) => {
    const validated = validateProposedAction(reviewedAction);
    assert.equal(validated.ok, true);
    await writeFile(manifestPath, JSON.stringify({
      version: 1,
      actions: [{ actionSha256: actionSha256(validated.value), dependencies }],
      ...additions,
    }), { mode: 0o600 });
  };
  const writeRawManifest = async (value: unknown) => {
    await writeFile(manifestPath, JSON.stringify(value), { mode: 0o600 });
  };
  if (options.writeManifest !== false) await writeManifest();
  return {
    temporaryHome, home, dependencyPath, manifestPath, contents, request, writeManifest, writeRawManifest,
    async cleanup() { await rm(temporaryHome, { recursive: true, force: true }); },
  };
}

function service(home: string, runAppServer: (prompt: string) => Promise<string>, approvalStore = { has: async () => false, remember: async () => {} }) {
  return createReviewService({
    dependencyPolicyHome: home,
    authAvailable: async () => true,
    approvalStore,
    runAppServer: async (prompt) => runAppServer(prompt),
  });
}

test('a fresh explicit review may use an exact host-pinned node_modules executable', { skip: dependencyVerificationUnsupported }, async () => {
  const state = await fixture();
  try {
    let prompt = '';
    const reviewer = service(state.home, async (value) => { prompt = value; return JSON.stringify(allow); });
    const result = await reviewer.reviewSensitiveAction(state.request);

    assert.equal(result.verdict, 'allow');
    assert.match(prompt, /HOST-VERIFIED EXECUTABLE DEPENDENCY EVIDENCE/u);
    assert.ok(prompt.includes(state.dependencyPath));
    assert.ok(prompt.includes('Hashes verify identity only'));
    assert.ok(!prompt.includes(createHash('sha256').update(state.contents).digest('hex')));
    assert.ok(!prompt.includes(state.contents));
    const validated = validateProposedAction(state.request);
    assert.equal(validated.ok, true);
    if (!validated.ok) throw new Error('fixture action unexpectedly failed validation');
    assert.equal(result.actionSha256, actionSha256(validated.value));
    assert.match(result.decisionSha256 ?? '', /^[a-f0-9]{64}$/u);
    assert.match(result.dependencyPolicySha256 ?? '', /^[a-f0-9]{64}$/u);
  } finally {
    await state.cleanup();
  }
});

test('missing manifest keeps the default node_modules blocker', async () => {
  const state = await fixture({ writeManifest: false });
  try {
    let prompt = '';
    const result = await service(state.home, async (value) => { prompt = value; return JSON.stringify(allow); }).reviewSensitiveAction(state.request);
    assert.equal(result.verdict, 'deny');
    assert.ok(!prompt.includes('HOST-VERIFIED EXECUTABLE DEPENDENCY EVIDENCE'));
    assert.equal(result.decisionSha256, undefined);
    assert.equal(result.dependencyPolicySha256, undefined);
  } finally {
    await state.cleanup();
  }
});

test('fresh model deny and needs_user verdicts remain unchanged with verified dependency evidence', async () => {
  for (const verdict of ['deny', 'needs_user'] as const) {
    const state = await fixture();
    try {
      const result = await service(state.home, async () => JSON.stringify({ ...allow, verdict })).reviewSensitiveAction(state.request);
      assert.equal(result.verdict, verdict);
      if (dependencyVerificationUnsupported) assert.equal(result.decisionSha256, undefined);
      else assert.match(result.decisionSha256 ?? '', /^[a-f0-9]{64}$/u);
    } finally {
      await state.cleanup();
    }
  }
});

for (const operationKind of ['database', 'process_spawn'] as const) {
  test(`an exact explicit ${operationKind} action may use a fresh executable dependency pin`, { skip: dependencyVerificationUnsupported }, async () => {
    const state = await fixture();
    try {
      const request = { ...state.request, operationKind };
      await state.writeManifest(undefined, {}, request);
      const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(request);
      assert.equal(result.verdict, 'allow');
      assert.ok(result.decisionSha256);
      assert.ok(result.dependencyPolicySha256);
    } finally {
      await state.cleanup();
    }
  });
}

for (const operationKind of ['file_read', 'file_write', 'file_delete', 'file_move', 'permission_change', 'credential_change'] as const) {
  test(`${operationKind} remains blocked even when its action digest appears in a manifest`, async () => {
    const state = await fixture();
    try {
      const request = { ...state.request, operationKind, ...(operationKind.startsWith('file_') ? { command: undefined } : {}) };
      await state.writeManifest(undefined, {}, request);
      const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(request);
      assert.equal(result.verdict, 'deny');
      assert.equal(result.decisionSha256, undefined);
      assert.ok(result.detectedHazards.some((hazard) => hazard.includes('file target may contain credentials or secrets')));
    } finally {
      await state.cleanup();
    }
  });
}

test('missing user authorization does not use a dependency pin', async () => {
  const state = await fixture();
  try {
    let calls = 0;
    const result = await service(state.home, async () => { calls += 1; return JSON.stringify(allow); })
      .reviewSensitiveAction({ ...state.request, userAuthorization: 'none' });
    assert.equal(result.verdict, 'deny');
    assert.equal(calls, 1);
    assert.equal(result.decisionSha256, undefined);
  } finally {
    await state.cleanup();
  }
});

test('a changed reason or command cannot reuse an action-bound pin', async () => {
  for (const changedAction of [
    (request: Fixture['request']) => ({ ...request, reason: 'Run the helper for a different purpose.' }),
    (request: Fixture['request']) => ({ ...request, command: `${request.command} --different-mode` }),
  ]) {
    const state = await fixture();
    try {
      const request = changedAction(state.request);
      const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(request);
      assert.equal(result.verdict, 'deny');
      assert.equal(result.decisionSha256, undefined);
      assert.equal(result.dependencyPolicySha256, undefined);
    } finally {
      await state.cleanup();
    }
  }
});

test('MCP action metadata cannot inject a policy home or dependency proof', async () => {
  const state = await fixture();
  try {
    let calls = 0;
    const result = await service(state.home, async () => { calls += 1; return JSON.stringify(allow); }).reviewSensitiveAction({
      ...state.request,
      dependencyPolicyHome: state.home,
      executableDependencyProof: {
        actionSha256: '0'.repeat(64),
        dependencies: [{ path: state.dependencyPath, sha256: 'a'.repeat(64) }],
      },
    });
    assert.equal(result.verdict, 'deny');
    assert.equal(result.actionSha256, null);
    assert.equal(calls, 0);
  } finally {
    await state.cleanup();
  }
});

test('only exact verified node_modules targets lose the path blocker', async () => {
  const unpinnedTarget = '/opt/workspace/node_modules/other-package/index.js';
  const state = await fixture({ additionalTargets: [unpinnedTarget] });
  try {
    const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(state.request);
    assert.equal(result.verdict, 'deny');
    assert.ok(result.detectedHazards.some((hazard) => hazard.includes('file target may contain credentials or secrets')));
  } finally {
    await state.cleanup();
  }
});

test('verified dependencies never exempt another protected path in the same action', async () => {
  const state = await fixture({ additionalTargets: ['/workspace/.npmrc'] });
  try {
    const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(state.request);
    assert.equal(result.verdict, 'deny');
    assert.ok(result.detectedHazards.some((hazard) => hazard.includes('file target may contain credentials or secrets')));
  } finally {
    await state.cleanup();
  }
});

test('a command substring without an exact file target cannot mint dependency evidence', async () => {
  const state = await fixture();
  try {
    const request = { ...state.request, fileTargets: [] };
    await state.writeManifest(undefined, {}, request);
    let prompt = '';
    const result = await service(state.home, async (value) => { prompt = value; return JSON.stringify(allow); }).reviewSensitiveAction(request);
    assert.ok(!prompt.includes('HOST-VERIFIED EXECUTABLE DEPENDENCY EVIDENCE'));
    assert.equal(result.decisionSha256, undefined);
  } finally {
    await state.cleanup();
  }
});

test('unknown manifest fields fail closed', async () => {
  const state = await fixture();
  try {
    await state.writeManifest(undefined, { unexpected: true });
    const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(state.request);
    assert.equal(result.verdict, 'deny');
    assert.equal(result.dependencyPolicySha256, undefined);
  } finally {
    await state.cleanup();
  }
});

for (const invalidManifest of ['wrong-file-hash', 'wrong-action-digest', 'duplicate-path', 'duplicate-action'] as const) {
  test(`${invalidManifest} manifest binding fails closed`, async () => {
    const state = await fixture();
    try {
      const validated = validateProposedAction(state.request);
      assert.equal(validated.ok, true);
      if (!validated.ok) throw new Error('fixture action unexpectedly failed validation');
      const actionDigest = actionSha256(validated.value);
      const dependency = {
        path: state.dependencyPath,
        sha256: createHash('sha256').update(state.contents).digest('hex'),
      };
      const wrongHash = { ...dependency, sha256: '0'.repeat(64) };
      const action = { actionSha256: actionDigest, dependencies: [dependency] };
      const actions = invalidManifest === 'wrong-file-hash'
        ? [{ ...action, dependencies: [wrongHash] }]
        : invalidManifest === 'wrong-action-digest'
          ? [{ ...action, actionSha256: '0'.repeat(64) }]
          : invalidManifest === 'duplicate-path'
            ? [{ ...action, dependencies: [dependency, dependency] }]
            : [action, action];
      await state.writeRawManifest({ version: 1, actions });
      const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(state.request);
      assert.equal(result.verdict, 'deny');
      assert.equal(result.dependencyPolicySha256, undefined);
    } finally {
      await state.cleanup();
    }
  });
}

test('manifest entry count and manifest byte limits fail closed', async () => {
  for (const oversized of ['entries', 'bytes'] as const) {
    const state = await fixture();
    try {
      if (oversized === 'entries') {
        const validated = validateProposedAction(state.request);
        assert.equal(validated.ok, true);
        if (!validated.ok) throw new Error('fixture action unexpectedly failed validation');
        const dependency = { path: state.dependencyPath, sha256: createHash('sha256').update(state.contents).digest('hex') };
        await writeFile(state.manifestPath, JSON.stringify({
          version: 1,
          actions: Array.from({ length: 9 }, (_, index) => ({
            actionSha256: `${String(index).padStart(2, '0')}${'a'.repeat(62)}`,
            dependencies: [dependency],
          })),
        }), { mode: 0o600 });
      } else {
        await truncate(state.manifestPath, 64 * 1024 + 1);
      }
      const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(state.request);
      assert.equal(result.verdict, 'deny');
      assert.equal(result.dependencyPolicySha256, undefined);
    } finally {
      await state.cleanup();
    }
  }
});

test('dependency size is checked before its contents are read', async () => {
  const state = await fixture();
  try {
    await truncate(state.dependencyPath, 64 * 1024 * 1024 + 1);
    const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(state.request);
    assert.equal(result.verdict, 'deny');
    assert.equal(result.dependencyPolicySha256, undefined);
  } finally {
    await state.cleanup();
  }
});

for (const failure of ['symlink', 'hardlink', 'group-writable'] as const) {
  test(`${failure} executable dependency is rejected before assisted approval`, async () => {
    const state = await fixture();
    try {
      const alias = `${state.dependencyPath}.alias`;
      if (failure === 'symlink') {
        await rm(state.dependencyPath);
        await symlink(join(dirname(state.dependencyPath), 'actual.js'), state.dependencyPath);
        await writeFile(join(dirname(state.dependencyPath), 'actual.js'), state.contents, { mode: 0o600 });
      } else if (failure === 'hardlink') {
        await link(state.dependencyPath, alias);
      } else {
        await chmod(state.dependencyPath, 0o620);
      }
      const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(state.request);
      assert.equal(result.verdict, 'deny');
      assert.equal(result.dependencyPolicySha256, undefined);
    } finally {
      await state.cleanup();
    }
  });
}

for (const change of ['in-place', 'atomic', 'parent-replacement', 'manifest-revocation', 'manifest-replacement'] as const) {
  test(`post-model ${change} invalidates the original dependency snapshot`, async () => {
    const state = await fixture();
    try {
      const packageDirectory = dirname(state.dependencyPath);
      const reviewer = service(state.home, async () => {
        if (change === 'in-place') {
          await writeFile(state.dependencyPath, state.contents, { mode: 0o600 });
        } else if (change === 'atomic') {
          const replacement = join(packageDirectory, 'replacement.js');
          await writeFile(replacement, state.contents, { mode: 0o600 });
          await rename(replacement, state.dependencyPath);
        } else if (change === 'parent-replacement') {
          const movedDirectory = `${packageDirectory}-moved`;
          await rename(packageDirectory, movedDirectory);
          await mkdir(packageDirectory, { mode: 0o700 });
          await writeFile(state.dependencyPath, state.contents, { mode: 0o600 });
        } else if (change === 'manifest-replacement') {
          const replacement = `${state.manifestPath}.replacement`;
          await writeFile(replacement, await readFile(state.manifestPath), { mode: 0o600 });
          await rename(replacement, state.manifestPath);
        } else {
          await rm(state.manifestPath);
        }
        return JSON.stringify(allow);
      });
      const result = await reviewer.reviewSensitiveAction(state.request);
      assert.equal(result.verdict, 'deny');
      assert.equal(result.dependencyPolicySha256, undefined);
    } finally {
      await state.cleanup();
    }
  });
}

test('ordinary sibling activity does not change a verified dependency identity', { skip: dependencyVerificationUnsupported }, async () => {
  const state = await fixture();
  try {
    const result = await service(state.home, async () => {
      const sibling = join(dirname(state.dependencyPath), 'temporary-review-sibling');
      await writeFile(sibling, 'temporary fixture', { mode: 0o600 });
      await rm(sibling);
      return JSON.stringify(allow);
    }).reviewSensitiveAction(state.request);
    assert.equal(result.verdict, 'allow');
    assert.ok(result.dependencyPolicySha256);
  } finally {
    await state.cleanup();
  }
});

test('fresh decision evidence changes when an identical manifest is atomically replaced', { skip: dependencyVerificationUnsupported }, async () => {
  const state = await fixture();
  try {
    const reviewer = service(state.home, async () => JSON.stringify(allow));
    const first = await reviewer.reviewSensitiveAction(state.request);
    const replacement = `${state.manifestPath}.replacement`;
    await writeFile(replacement, await readFile(state.manifestPath), { mode: 0o600 });
    await rename(replacement, state.manifestPath);
    const second = await reviewer.reviewSensitiveAction(state.request);
    assert.equal(first.verdict, 'allow');
    assert.equal(second.verdict, 'allow');
    assert.notEqual(first.dependencyPolicySha256, second.dependencyPolicySha256);
    assert.notEqual(first.decisionSha256, second.decisionSha256);
  } finally {
    await state.cleanup();
  }
});

test('candidate dependency reviews bypass learned and result-cache reuse', async () => {
  const state = await fixture();
  try {
    let calls = 0, learnedReads = 0, learnedWrites = 0;
    const reviewer = service(state.home, async () => JSON.stringify({ ...allow, verdict: ++calls === 1 ? 'allow' : 'deny' }), {
      has: async () => { learnedReads += 1; return true; },
      remember: async () => { learnedWrites += 1; },
    });
    assert.equal((await reviewer.reviewSensitiveAction(state.request)).verdict, dependencyVerificationUnsupported ? 'deny' : 'allow');
    assert.equal((await reviewer.reviewSensitiveAction(state.request)).verdict, 'deny');
    assert.equal(calls, 2);
    assert.equal(learnedReads, 0);
    assert.equal(learnedWrites, 0);
  } finally {
    await state.cleanup();
  }
});

test('an already-cancelled candidate never reads policy or calls the model', async () => {
  const state = await fixture();
  try {
    let calls = 0, learnedReads = 0;
    const reviewer = service(state.home, async () => { calls += 1; return JSON.stringify(allow); }, {
      has: async () => { learnedReads += 1; return false; }, remember: async () => {},
    });
    const controller = new AbortController();
    controller.abort();
    const result = await reviewer.reviewSensitiveAction(state.request, { signal: controller.signal });
    assert.ok(result.detectedHazards.includes('reviewer_cancelled'));
    assert.equal(calls, 0);
    assert.equal(learnedReads, 0);
  } finally {
    await state.cleanup();
  }
});

test('manifest must have owner-private mode', async () => {
  const state = await fixture();
  try {
    await chmod(state.manifestPath, 0o644);
    const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(state.request);
    assert.equal(result.verdict, 'deny');
  } finally {
    await state.cleanup();
  }
});

for (const contents of [Buffer.from('7f454c4602010100000000000000000002003e0001000000', 'hex'), Buffer.from('fixture text')]) {
  const isNative = contents.subarray(0, 4).toString('hex') === '7f454c46';
  test(`extensionless dependency ${contents.subarray(0, 4).toString('hex')} is checked as a native executable`, { skip: dependencyVerificationUnsupported && isNative }, async () => {
    const state = await fixture({ writeManifest: false });
    try {
      const dependencyPath = join(dirname(state.dependencyPath), 'schema-engine');
      await writeFile(dependencyPath, contents, { mode: 0o700 });
      const request = { ...state.request, command: `node ${dependencyPath}`, fileTargets: [dependencyPath] };
      const validated = validateProposedAction(request);
      assert.equal(validated.ok, true);
      if (!validated.ok) throw new Error('fixture action unexpectedly failed validation');
      await state.writeManifest([{ path: dependencyPath, sha256: createHash('sha256').update(contents).digest('hex') }], {}, request);
      const result = await service(state.home, async () => JSON.stringify(allow)).reviewSensitiveAction(request);
      assert.equal(result.verdict, isNative && !dependencyVerificationUnsupported ? 'allow' : 'deny');
    } finally {
      await state.cleanup();
    }
  });
}
