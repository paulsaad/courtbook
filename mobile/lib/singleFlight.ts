/**
 * One call in flight per action key (docs/m3/05-architecture.md §5.3, test plan U8).
 *
 * A second tap while the first call is still running gets the SAME promise back — it never starts a
 * second request. When the call settles (success or failure) the key is free again.
 *
 * This only stops the phone sending a duplicate. It is not what makes a repeated action safe: the
 * game functions themselves are idempotent or state-checked (join_match returns the existing status,
 * leave_match on a missing row does nothing, decide_join refuses `not_pending`).
 */
export function createSingleFlight() {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, call: () => Promise<T>): Promise<T> {
      const current = inFlight.get(key);
      if (current) return current as Promise<T>;
      const p = (async () => {
        try {
          return await call();
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, p);
      return p;
    },
    busy(key: string): boolean {
      return inFlight.has(key);
    },
  };
}
