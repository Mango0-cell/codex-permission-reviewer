export class ReviewSchedulingError extends Error {
  constructor(hazard) {
    super(hazard);
    this.name = "ReviewSchedulingError";
    this.hazard = hazard;
  }
}

// One deadline covers local reuse, queue waiting, authentication, model work and
// policy checks. A timed-out adapter cannot make its caller wait for cleanup.
export async function withReviewDeadline(run, { signal, timeoutMs }) {
  if (signal?.aborted) throw new ReviewSchedulingError("reviewer_cancelled");
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const cancel = (hazard) => {
    rejectAborted(new ReviewSchedulingError(hazard));
    controller.abort(hazard);
  };
  const onAbort = () => cancel("reviewer_cancelled");
  const timer = setTimeout(() => cancel("reviewer_timeout"), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal, () => Math.max(1, deadline - performance.now()))),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// Keep the slot until actual completion, including adapter cleanup, even if a
// caller has timed out. This prevents a cancellation from overlapping children.
export function createReviewScheduler({ maxQueued = 4 } = {}) {
  let active = false;
  const queue = [];

  function pump() {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = true;
    job.started = true;
    void (async () => {
      try { job.finish(null, await job.run(job.signal)); }
      catch (error) { job.finish(error); }
      finally { active = false; pump(); }
    })();
  }

  function schedule(run, { signal }) {
    if (signal.aborted) return Promise.reject(new ReviewSchedulingError(signal.reason === "reviewer_timeout" ? "reviewer_timeout" : "reviewer_cancelled"));
    if (active && queue.length >= maxQueued) return Promise.reject(new ReviewSchedulingError("reviewer_queue_full"));
    return new Promise((resolve, reject) => {
      const job = {
        run, signal, started: false, settled: false,
        finish(error, result) {
          if (job.settled) return;
          job.settled = true;
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve(result);
        },
      };
      const onAbort = () => {
        job.finish(new ReviewSchedulingError(signal.reason === "reviewer_timeout" ? "reviewer_timeout" : "reviewer_cancelled"));
        if (!job.started) {
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      queue.push(job);
      pump();
    });
  }
  return { schedule };
}
