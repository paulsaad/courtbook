import { describe, expect, it, vi } from "vitest";
import { bounded } from "./bounded";

describe("bounded", () => {
  it("returns the value when the work finishes in time", async () => {
    expect(await bounded(1000, async () => 42)).toEqual({ done: true, value: 42 });
  });
  it("an error is a result, not a throw", async () => {
    expect(await bounded(1000, async () => { throw new Error("x"); })).toEqual({ done: false, reason: "error" });
  });
  it("on time-out: continues at once and aborts the work's signal", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | null = null;
      const p = bounded(100, (s) => { seen = s; return new Promise<never>(() => {}); });
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toEqual({ done: false, reason: "timeout" });
      expect(seen!.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("after the work finishes, its signal is aborted too (nothing it started may go on)", async () => {
    let seen: AbortSignal | null = null;
    await bounded(1000, async (s) => { seen = s; return 1; });
    expect(seen!.aborted).toBe(true);
  });
});
