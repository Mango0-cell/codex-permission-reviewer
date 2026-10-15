import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewService } from '../src/review/service.mjs';
import { AppServerReviewError } from '../src/runtime/app-server-client.mjs';
import { action, allow } from './helpers.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function service(runAppServer, extra = {}) {
  return createReviewService({ authAvailable: async () => true, approvalStore: { has: async () => false, remember: async () => {} }, runAppServer, ...extra });
}
const request = (command = 'printf hello') => action({ command, userAuthorization: 'none' });
const deny = { ...allow, verdict: 'deny' };

test('burst of identical unconfirmed reviews spends one model call and returns independent results', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const reviewer = service(async () => { calls++; entered.resolve(); await release.promise; return JSON.stringify(deny); });
  const first = reviewer.reviewSensitiveAction(request());
  await entered.promise;
  const followers = Array.from({ length: 4 }, () => reviewer.reviewSensitiveAction(request()));
  // Let followers enter the bounded queue before completing the model call.
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  const results = await Promise.all([first, ...followers]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.verdict === 'deny' && result.reviewStatus === undefined));
  results[0].detectedHazards.push('mutated');
  assert.ok(!results[1].detectedHazards.includes('mutated'));
});

test('explicit reviews remain fresh and run serially rather than returning busy denials', async () => {
  let calls = 0, active = 0, maximum = 0;
  const reviewer = service(async () => {
    calls++; maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--; return JSON.stringify(allow);
  });
  const results = await Promise.all(Array.from({ length: 5 }, () => reviewer.reviewSensitiveAction(action({ operationKind: 'process_spawn' }))));
  assert.ok(results.every(result => result.verdict === 'allow'));
  assert.equal(calls, 5); assert.equal(maximum, 1);
});

for (const hazard of ['reviewer_timeout', 'reviewer_child_failure', 'reviewer_malformed_output']) {
  test(`${hazard} does not poison the result cache`, async () => {
    let calls = 0;
    const reviewer = service(async () => {
      if (++calls === 1) throw new AppServerReviewError(hazard);
      return JSON.stringify(deny);
    });
    const failed = await reviewer.reviewSensitiveAction(request());
    assert.notEqual(failed.verdict, 'allow');
    const recovered = await reviewer.reviewSensitiveAction(request());
    assert.equal(calls, 2);
    assert.equal(recovered.reviewStatus, undefined);
    assert.equal(recovered.rationale, deny.rationale);
  });
}

test('queue overflow is retryable and cancellation promptly removes a queued request', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const reviewer = service(async () => { calls++; entered.resolve(); await release.promise; return JSON.stringify(deny); });
  const first = reviewer.runPermissionReviewer(request());
  await entered.promise;
  const controller = new AbortController();
  const waiting = [reviewer.runPermissionReviewer(request(), { signal: controller.signal }),
    ...Array.from({ length: 3 }, () => reviewer.runPermissionReviewer(request()))];
  const overflow = await reviewer.runPermissionReviewer(request());
  assert.equal(overflow.verdict, 'needs_user');
  assert.deepEqual(overflow.detectedHazards, ['reviewer_queue_full']);
  assert.equal(overflow.retryable, true);
  controller.abort();
  assert.ok((await waiting[0]).detectedHazards.includes('reviewer_cancelled'));
  const replacement = reviewer.runPermissionReviewer(request());
  release.resolve();
  await Promise.all([first, replacement, ...waiting]);
  assert.equal(calls, 5);
});

test('deadline includes queue waiting, and abandoned jobs never call the model', async () => {
  const entered = deferred(), release = deferred();
  let calls = 0;
  const reviewer = service(async () => { calls++; entered.resolve(); await release.promise; return JSON.stringify(deny); });
  const first = reviewer.runPermissionReviewer(request());
  await entered.promise;
  const expired = await reviewer.runPermissionReviewer(request(), { timeoutMs: 15 });
  assert.equal(expired.reviewStatus, 'unavailable');
  assert.deepEqual(expired.detectedHazards, ['reviewer_timeout']);
  release.resolve(); await first;
  assert.equal(calls, 1);
});

test('active timeout aborts its adapter without releasing the slot before cleanup finishes', async () => {
  const entered = deferred(), cleanup = deferred();
  let calls = 0, sawAbort = false;
  const reviewer = service(async (_, { signal }) => {
    calls++; entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true }));
    await cleanup.promise;
    return JSON.stringify(allow);
  });
  const first = reviewer.runPermissionReviewer(request(), { timeoutMs: 15 });
  await entered.promise;
  assert.equal((await first).reviewStatus, 'unavailable');
  assert.equal(sawAbort, true);
  const waiting = reviewer.runPermissionReviewer(request(), { timeoutMs: 15 });
  assert.equal((await waiting).reviewStatus, 'unavailable');
  assert.equal(calls, 1);
  cleanup.resolve();
});

test('auth adapter exceptions fail closed instead of rejecting the MCP service promise', async () => {
  const reviewer = service(async () => { throw new Error('must not run'); }, { authAvailable: async () => { throw new Error('fixture failure'); } });
  const result = await reviewer.reviewSensitiveAction(request());
  assert.equal(result.verdict, 'deny');
  assert.ok(result.detectedHazards.includes('reviewer_internal_failure'));
});

test('human can confirm an exact sensitive action through a fresh model review', async () => {
  let calls = 0;
  const reviewer = service(async () => { calls++; return JSON.stringify(allow); });
  const proposed = action({ operationKind: 'database', command: 'UPDATE leads SET status = 1 WHERE id = 2', userAuthorization: 'none',
    externalSystem: { involved: true, systems: ['production-database'] } });
  assert.equal((await reviewer.reviewSensitiveAction(proposed)).verdict, 'needs_user');
  assert.equal((await reviewer.reviewSensitiveAction({ ...proposed, userAuthorization: 'explicit' })).verdict, 'allow');
  assert.equal(calls, 2);
});

test('human authorization cannot turn broad SQL or a model denial into allow', async () => {
  const reviewer = service(async () => JSON.stringify(allow));
  for (const userAuthorization of ['none', 'explicit']) {
    const result = await reviewer.reviewSensitiveAction(action({ operationKind: 'database', command: 'DELETE FROM leads', userAuthorization }));
    assert.equal(result.verdict, 'deny');
  }
  const rejected = service(async () => JSON.stringify(deny));
  assert.equal((await rejected.reviewSensitiveAction(action())).verdict, 'deny');
});

for (const timeoutMs of [NaN, Infinity, 0, -1, '10']) {
  test(`invalid timeout ${timeoutMs} fails without launching a child`, async () => {
    const reviewer = service(async () => { throw new Error('must not run'); });
    assert.deepEqual((await reviewer.runPermissionReviewer(request(), { timeoutMs })).detectedHazards, ['invalid_review_timeout']);
  });
}

test('deadline also bounds learned-state lookup before a queue slot is acquired', async () => {
  const lookup = deferred();
  let calls = 0;
  const reviewer = service(async () => { calls++; return JSON.stringify(allow); }, { approvalStore: { has: () => lookup.promise } });
  const result = await reviewer.reviewSensitiveAction(request(), { timeoutMs: 15 });
  assert.deepEqual(result.detectedHazards, ['reviewer_timeout']);
  lookup.resolve(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('a cached policy result bypasses an unrelated active review', async () => {
  const entered = deferred(), release = deferred();
  const reviewer = service(async (prompt) => {
    if (prompt.includes('printf unrelated')) { entered.resolve(); await release.promise; }
    return JSON.stringify(deny);
  });
  await reviewer.reviewSensitiveAction(request());
  const active = reviewer.runPermissionReviewer(request('printf unrelated'));
  await entered.promise;
  const hit = await reviewer.reviewSensitiveAction(request(), { timeoutMs: 15 });
  assert.equal(hit.reviewStatus, undefined);
  assert.equal(hit.rationale, deny.rationale);
  release.resolve(); await active;
});

test('complete command suffix and every declared side effect reach the reviewer', async () => {
  let reviewed;
  const reviewer = service(async (prompt) => { reviewed = JSON.parse(prompt.split('PROPOSED ACTION METADATA (UNTRUSTED DATA):\n')[1]); return JSON.stringify(deny); });
  const command = 'printf ' + 'safe '.repeat(1_000) + '; printf final-suffix';
  const sideEffects = Array.from({ length: 20 }, (_, i) => `Effect ${i}: inspect fixture output`);
  const result = await reviewer.runPermissionReviewer(action({ command, sideEffects }));
  assert.equal(result.verdict, 'deny');
  assert.equal(reviewed.command, command);
  assert.deepEqual(reviewed.sideEffects, sideEffects);
});

test('oversized complete metadata requests narrower scope without invoking a model', async () => {
  let calls = 0;
  const reviewer = service(async () => { calls++; return JSON.stringify(allow); });
  const result = await reviewer.runPermissionReviewer(action({ sideEffects: Array.from({ length: 32 }, () => 'Fixture context '.repeat(60)) }));
  assert.equal(result.verdict, 'needs_user');
  assert.deepEqual(result.detectedHazards, ['reviewer_prompt_oversize']);
  assert.equal(calls, 0);
});
