import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewScheduler } from '../src/review/scheduler.ts';

test('completion frees scheduler capacity before a caller schedules more work', async () => {
  const scheduler = createReviewScheduler();
  const signal = new AbortController().signal;
  let releaseFirst!: () => void;
  let releaseRest!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const restGate = new Promise<void>(resolve => { releaseRest = resolve; });
  const first = scheduler.schedule(async () => { await firstGate; return 1; }, { signal });
  const rest = Array.from({ length: 4 }, (_, i) => scheduler.schedule(async () => { await restGate; return i + 2; }, { signal }));
  const next = first.then(() => scheduler.schedule(async () => 6, { signal }));
  releaseFirst();
  await first;
  releaseRest();
  assert.deepEqual(await Promise.all([first, ...rest, next]), [1, 2, 3, 4, 5, 6]);
});
