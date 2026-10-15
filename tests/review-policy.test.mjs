import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReviewService } from '../src/review/service.mjs';
import { validateProposedAction } from '../src/action/metadata.mjs';
import { learnedApprovalBlockers } from '../src/policy/policy.mjs';
import { action, allow } from './helpers.mjs';

for (const verdict of ['allow', 'deny', 'needs_user']) {
  test(`explicit authorization preserves model ${verdict}`, async () => {
    let calls = 0;
    const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => { calls++; return JSON.stringify({ ...allow, verdict }); } });
    const result = await service.runPermissionReviewer(action());
    assert.equal(result.verdict, verdict);
    assert.equal(calls, 1);
    assert.match(result.actionSha256, /^[a-f0-9]{64}$/u);
  });
}
for (const command of ['rm -fr /tmp/example', 'rm --recursive --force /tmp/example', 'git push -f', 'DELETE FROM leads']) {
  test(`explicit model allow cannot override ${command}`, async () => {
    const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => JSON.stringify(allow) });
    assert.equal((await service.runPermissionReviewer(action({ command }))).verdict, 'deny');
    const validated = validateProposedAction(action({ command }));
    assert.equal(validated.ok, true);
    assert.ok(learnedApprovalBlockers(validated.value).length);
  });
}
test('Docker correction does not automatically authorize a command', async () => {
  const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => JSON.stringify(allow) });
  const command = 'docker run --rm --read-only --tmpfs /scratch:rw alpine id';
  assert.notEqual((await service.runPermissionReviewer(action({ command, userAuthorization: 'none' }))).verdict, 'allow');
  assert.equal((await service.runPermissionReviewer(action({ command }))).verdict, 'allow');
});
test('malformed response and missing auth fail closed', async () => {
  const malformed = createReviewService({ authAvailable: async () => true, runAppServer: async () => 'not JSON' });
  assert.equal((await malformed.runPermissionReviewer(action())).verdict, 'deny');
  const missing = createReviewService({ authAvailable: async () => false, runAppServer: async () => { throw new Error('must not launch'); } });
  assert.equal((await missing.runPermissionReviewer(action())).verdict, 'deny');
});
test('explicit reviews bypass result cache; denials are never learned', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cpr-test-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    let calls = 0;
    const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => JSON.stringify({ ...allow, verdict: ++calls === 1 ? 'allow' : 'deny' }) });
    // A never-learned category avoids intentionally persisted exact approvals.
    const request = action({ operationKind: 'process_spawn' });
    assert.equal((await service.reviewSensitiveAction(request)).verdict, 'allow');
    assert.equal((await service.reviewSensitiveAction(request)).verdict, 'deny');
    assert.equal(calls, 2);
    await assert.rejects(readFile(join(home, 'plugin-state/codex-permission-reviewer/learned-approvals.json')), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
test('request validation rejects unknown fields and raw secrets before review', async () => {
  const service = createReviewService({ authAvailable: async () => { throw new Error('must not check auth'); } });
  for (const request of [action({ injected: true }), action({ command: 'TOKEN=1234567890abcdef1234567890abcdef printf hello' })]) {
    assert.equal((await service.reviewSensitiveAction(request)).verdict, 'deny');
  }
});
test('concurrency and rolling budget fail closed without launching extra reviewers', async () => {
  let finish;
  let calls = 0;
  const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => { calls++; return new Promise(resolve => { finish = () => resolve(JSON.stringify(allow)); }); } });
  const request = action({ operationKind: 'process_spawn' });
  const pending = service.reviewSensitiveAction(request);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  const busy = await service.reviewSensitiveAction(request);
  assert.ok(busy.detectedHazards.includes('reviewer_busy'));
  finish();
  await pending;
  assert.equal(calls, 1);
  const limited = createReviewService({ authAvailable: async () => true, runAppServer: async () => JSON.stringify(allow) });
  for (let i = 0; i < 5; i++) assert.equal((await limited.reviewSensitiveAction(request)).verdict, 'allow');
  assert.ok((await limited.reviewSensitiveAction(request)).detectedHazards.includes('reviewer_rate_limited'));
});
test('learned approvals store hashes only, match exact scope, and respect cancellation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cpr-memory-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    let calls = 0;
    const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => { calls++; return JSON.stringify(allow); } });
    const request = action();
    assert.equal((await service.reviewSensitiveAction(request)).verdict, 'allow');
    const raw = await readFile(join(home, 'plugin-state/codex-permission-reviewer/learned-approvals.json'), 'utf8');
    assert.ok(!raw.includes(request.command));
    assert.ok(!raw.includes(request.reason));
    assert.match(JSON.parse(raw).approvals[0].digest, /^[a-f0-9]{64}$/u);
    assert.equal((await service.reviewSensitiveAction({ ...request, userAuthorization: 'none' })).verdict, 'allow');
    assert.equal(calls, 1);
    assert.notEqual((await service.reviewSensitiveAction({ ...request, command: 'printf changed', userAuthorization: 'none' })).verdict, 'allow');
    const controller = new AbortController(); controller.abort();
    assert.equal((await service.reviewSensitiveAction({ ...request, userAuthorization: 'none' }, { signal: controller.signal })).verdict, 'deny');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
