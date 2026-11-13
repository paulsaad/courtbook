import { describeFreshness } from "../lib/freshness";

const T = Date.UTC(2026, 10, 14, 15, 0, 0);
const f = (o: Partial<Parameters<typeof describeFreshness>[0]>) =>
  describeFreshness({ lastSuccessAt: T, now: T, fetching: false, failedSinceSuccess: false, ...o });

describe("describeFreshness", () => {
  it("says 'just now' only right after a successful read", () => {
    expect(f({}).text).toBe("Checked just now");
    expect(f({ now: T + 14_000 }).text).toBe("Checked just now");
    expect(f({ now: T + 30_000 }).text).toBe("Checked 30 s ago");
    expect(f({ now: T + 3 * 60_000 }).text).toBe("Checked 3 min ago");
  });

  it("never claims a refresh happened when the last one failed", () => {
    const r = f({ now: T + 2_000, failedSinceSuccess: true });
    expect(r.tone).toBe("failed");
    expect(r.text).toMatch(/^Couldn't refresh · times as of \d\d:\d\d$/);
    expect(r.text).not.toMatch(/just now/);
  });

  it("goes stale after five minutes and asks for a refresh", () => {
    const r = f({ now: T + 6 * 60_000 });
    expect(r.tone).toBe("stale");
    expect(r.text).toMatch(/pull to refresh/);
  });

  it("says it is checking while a refetch runs, and that nothing is loaded before the first read", () => {
    expect(f({ fetching: true, now: T + 40_000 }).text).toBe("Checking for changes…");
    expect(f({ lastSuccessAt: 0, fetching: true }).text).toBe("Checking times…");
    expect(f({ lastSuccessAt: 0 }).tone).toBe("failed");
  });
});
