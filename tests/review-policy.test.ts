import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createReviewService } from '../src/review/service.js';
import { validateProposedAction } from '../src/action/metadata.js';
import { explicitAuthorizationBlockers, learnedApprovalBlockers } from '../src/policy/policy.js';
import { action, allow } from './helpers.js';
import { rememberLearnedApproval } from '../src/approvals/store.js';

for (const verdict of ['allow', 'deny', 'needs_user']) {
  test(`explicit authorization preserves model ${verdict}`, async () => {
    let calls = 0;
    const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => { calls++; return JSON.stringify({ ...allow, verdict }); } });
    const result = await service.runPermissionReviewer(action());
    assert.equal(result.verdict, verdict);
    assert.equal(calls, 1);
    assert.match(result.actionSha256!, /^[a-f0-9]{64}$/u);
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
  const result = await missing.runPermissionReviewer(action());
  assert.equal(result.verdict, 'needs_user');
  assert.equal(result.reviewStatus, 'unavailable');
  assert.equal(result.retryable, false);
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
test('rolling budget returns retry timing without launching extra reviewers', async () => {
  let calls = 0;
  const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => { calls++; return JSON.stringify(allow); } });
  const request = action({ operationKind: 'process_spawn' });
  for (let i = 0; i < 5; i++) assert.equal((await service.reviewSensitiveAction(request)).verdict, 'allow');
  const limited = await service.reviewSensitiveAction(request);
  assert.ok(limited.detectedHazards.includes('reviewer_rate_limited'));
  assert.equal(limited.reviewStatus, 'unavailable');
  assert.equal(limited.retryable, true);
  assert.ok(limited.retryAfterMs !== undefined);
  assert.ok(limited.retryAfterMs > 0 && limited.retryAfterMs <= 60_000);
  assert.equal(calls, 5);
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
    assert.ok(!raw.includes(request.command!));
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

for (const command of [
  'rm -f /tmp/report.txt', 'unlink /tmp/report.txt', 'rmdir /tmp/empty',
  'find /tmp -name report.txt -delete',
  'DELETE FROM leads WHERE id = 2', 'UPDATE leads SET status = 1 WHERE id = 2',
  'DELETE FROM "tasks" WHERE id = 2', 'UPDATE "tasks" SET status = 1 WHERE id = 2',
  `psql -c 'UPDATE "tasks" SET status = 1 WHERE id = 2'`,
]) {
  test(`known command mutation requires a fresh review but remains human-reviewable: ${command}`, () => {
    const validated = validateProposedAction(action({ operationKind: 'command', command, userAuthorization: 'explicit' }));
    assert.equal(validated.ok, true);
    assert.deepEqual(explicitAuthorizationBlockers(validated.value), []);
    assert.ok(learnedApprovalBlockers(validated.value).length > 0);
  });
}

test('a previously stored exact deletion hash cannot bypass fresh review', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cpr-old-deletion-hash-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const request = action({ operationKind: 'command', command: 'rm -f /tmp/report.txt', userAuthorization: 'explicit' });
    // Seed a valid version-1 hash as if it had been learned before this policy.
    const validated = validateProposedAction(request);
    assert.equal(validated.ok, true);
    await rememberLearnedApproval(validated.value);
    const statePath = join(home, 'plugin-state/codex-permission-reviewer/learned-approvals.json');
    const before = await readFile(statePath, 'utf8');
    let calls = 0;
    const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => { calls++; return JSON.stringify(allow); } });

    const result = await service.reviewSensitiveAction({ ...request, userAuthorization: 'none' });

    assert.equal(result.verdict, 'needs_user');
    assert.equal(calls, 1);
    assert.equal(await readFile(statePath, 'utf8'), before);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('explicitly reviewed file deletion is not persisted for later reuse', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cpr-no-deletion-memory-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const service = createReviewService({ authAvailable: async () => true, runAppServer: async () => JSON.stringify(allow) });
    const result = await service.reviewSensitiveAction(action({ operationKind: 'command', command: 'rm -f /tmp/report.txt' }));

    assert.equal(result.verdict, 'allow');
    await assert.rejects(readFile(join(home, 'plugin-state/codex-permission-reviewer/learned-approvals.json')), { code: 'ENOENT' });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
