export class ReviewSchedulingError extends Error {
  constructor(readonly hazard: string) {
    super(hazard);
    this.name = "ReviewSchedulingError";
  }
}

type ScheduledRun<T> = (signal: AbortSignal, remainingMs: () => number) => Promise<T>;
interface DeadlineOptions { signal?: AbortSignal | undefined; timeoutMs: number }
interface QueuedJob {
  started: boolean;
  signal: AbortSignal;
  start(): Promise<() => void>;
  fail(error: unknown): void;
}

export async function withReviewDeadline<T>(run: ScheduledRun<T>, { signal, timeoutMs }: DeadlineOptions): Promise<T> {
  if (signal?.aborted) throw new ReviewSchedulingError("reviewer_cancelled");
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  const cancel = (hazard: string) => {
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

export function createReviewScheduler({ maxQueued = 4 } = {}) {
  let active = false;
  const queue: QueuedJob[] = [];
  function pump(): void {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = true;
    job.started = true;
    void (async () => {
      try { const finish = await job.start(); finish(); }
      catch (error) { job.fail(error); }
      finally { active = false; pump(); }
    })();
  }
  function schedule<T>(run: (signal: AbortSignal) => Promise<T>, { signal }: { signal: AbortSignal }): Promise<T> {
    if (signal.aborted) return Promise.reject(new ReviewSchedulingError(signal.reason === "reviewer_timeout" ? "reviewer_timeout" : "reviewer_cancelled"));
    if (active && queue.length >= maxQueued) return Promise.reject(new ReviewSchedulingError("reviewer_queue_full"));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        complete();
      };
      const job: QueuedJob = {
        signal, started: false,
        async start() {
          const result = await run(signal);
          return () => finish(() => resolve(result));
        },
        fail(error) { finish(() => reject(error)); },
      };
      const onAbort = () => {
        finish(() => reject(new ReviewSchedulingError(signal.reason === "reviewer_timeout" ? "reviewer_timeout" : "reviewer_cancelled")));
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
