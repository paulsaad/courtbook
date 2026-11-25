/**
 * Runs `work` for at most `ms`. On time-out the AbortSignal given to `work` is aborted (so a well-behaved callee
 * stops its request and skips any later step) and the caller continues at once with { done: false }. Errors are
 * caught: bookkeeping that fails or hangs must never hold up the step that follows it (review 25 Nov).
 */
export type Bounded<T> = { done: true; value: T } | { done: false; reason: "timeout" | "error" };

export async function bounded<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<Bounded<T>> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => { ctl.abort(); resolve({ done: false, reason: "timeout" }); }, ms);
  });
  const run = (async (): Promise<Bounded<T>> => {
    try { return { done: true, value: await work(ctl.signal) }; } catch { return { done: false, reason: "error" }; }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    if (!ctl.signal.aborted) ctl.abort();   // finished or failed: nothing it started may continue afterwards
  }
}
