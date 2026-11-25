import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  LIMITS, appleLinkState, appleSubsFromUser, closeAppleAccount, closureFromRecords,
  type AppleDeletionDeps, type AppleDeletionInput, type CloseOutcome,
} from "./deletion";
import { AppleToken, type ExchangeResult, type RevokeResult, type VerifyResult } from "./revoke";

/**
 * The whole E1 flow against fakes, with the order of every step recorded. Reviews of 25 Nov:
 *  - first: stale session, Apple cancellation, wrong Apple identity, outage, failure after closure, several sign-in
 *    methods; fallback; server-side identity;
 *  - second: revoke before processing; a committed closure with a lost answer;
 *  - third: no account switching (two Apple accounts); a failed status lookup is "unknown", unlike an absent record;
 *    every awaited step is time-limited, so slow bookkeeping never holds up the deletion.
 */
const A = "aaaaaaaa-0000-4000-8000-00000000000a";   // the account that asked to be deleted
const B = "bbbbbbbb-0000-4000-8000-00000000000b";   // another CourtBook account, with its own Apple ID
type Ans<T> = T | "throw" | "hang";
type World = {
  userId?: string; subs?: Ans<string[] | null>; recent?: Ans<boolean | null>; exchange?: Ans<ExchangeResult>; verify?: Ans<VerifyResult>;
  close?: Ans<CloseOutcome>; closureStatus?: Ans<"closed" | "open" | "unknown">; process?: "throw" | "hang";
  revoke?: Ans<RevokeResult>; mark?: "throw" | "hang"; alert?: "throw" | "hang";
};
const never = () => new Promise<never>(() => {});
function world(w: World = {}) {
  const log: string[] = [];
  const alerts: [string, string][] = [];
  const signals: Record<string, AbortSignal> = {};
  const token = new AppleToken("RT-secret", "refresh_token");
  const ans = async <T,>(step: string, v: Ans<T> | undefined, dflt: T, signal?: AbortSignal): Promise<T> => {
    log.push(step);
    if (signal) signals[step] = signal;
    if (v === "throw") throw new Error("down");
    if (v === "hang") return never();
    return v === undefined ? dflt : v;
  };
  const deps: AppleDeletionDeps = {
    userId: w.userId ?? A,
    intentOwner: (intent) => (intent === "intent-A" ? A : intent === "intent-B" ? B : null),
    appleSubs: (s) => ans("subs", w.subs, (w.userId === B ? ["apple-B"] : ["apple-A"]) as string[] | null, s),
    recentlyAuthenticated: (s) => ans("recent", w.recent, true as boolean | null, s),
    exchange: (code, s) => ans(`exchange:${code}`, w.exchange, { ok: true, idToken: "IDT", token } as ExchangeResult, s),
    verify: (_t, s) => ans("verify", w.verify, { ok: true, sub: w.userId === B ? "apple-B" : "apple-A" } as VerifyResult, s),
    close: (s) => ans("close", w.close, { ok: true } as CloseOutcome, s),
    closureStatus: (s) => ans("status", w.closureStatus, "closed" as "closed" | "open" | "unknown", s),
    markRevocation: async (o, s) => { await ans(`mark:${o}`, w.mark, undefined, s); },
    process: async () => { await ans("process", w.process, undefined); },
    revoke: (t, s) => { expect(t).toBe(token); return ans("revoke", w.revoke, { ok: true } as RevokeResult, s); },
    alert: async (event, code, s) => { alerts.push([event, code]); await ans(`alert:${event}`, w.alert, undefined, s); },
  };
  return { deps, log, alerts, signals };
}
const APPLE: AppleDeletionInput = { method: "apple", code: "CODE-1", intent: "intent-A" };
const FALLBACK: AppleDeletionInput = { method: "fallback", intent: "intent-A" };
const steps = (log: string[]) => log.filter((l) => !l.startsWith("alert:"));
afterEach(() => { vi.useRealTimers(); });

describe("the happy path and its order", () => {
  it("intent → identity → recency → exchange → verify → close → revoke at once → mark → processing", async () => {
    const { deps, log, alerts } = world();
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: true, revocation: "done" });
    expect(log).toEqual(["subs", "recent", "exchange:CODE-1", "verify", "close", "revoke", "mark:done", "process"]);
    expect(alerts).toEqual([]);
  });
});

describe("third review, point 1: no account switching during Apple reauthentication", () => {
  it("TWO APPLE ACCOUNTS: A asked; the Apple sheet used B's Apple ID, which signed the app into account B → refused, nothing runs", async () => {
    // the request is now authenticated as B (B's session, B's own Apple ID, a valid code for B), but the intent is A's
    const { deps, log } = world({ userId: B });
    expect(await closeAppleAccount({ method: "apple", code: "CODE-B", intent: "intent-A" }, deps)).toEqual({ closed: false, code: "account_mismatch" });
    expect(log).toEqual([]);   // no lookup, no Apple call, no closure of B
  });
  it("…and the same for the fallback", async () => {
    const { deps, log } = world({ userId: B });
    expect(await closeAppleAccount({ method: "fallback", intent: "intent-A" }, deps)).toEqual({ closed: false, code: "account_mismatch" });
    expect(log).toEqual([]);
  });
  it("A still signed in as A but the Apple sheet used B's Apple ID → wrong_apple_account, nothing closed", async () => {
    const { deps, log } = world({ verify: { ok: true, sub: "apple-B" } });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "wrong_apple_account" });
    expect(log).not.toContain("close");
  });
  it("B's own intent with B's session works for B (the check binds, it does not block)", async () => {
    expect(await closeAppleAccount({ method: "apple", code: "CODE-B", intent: "intent-B" }, world({ userId: B }).deps)).toEqual({ closed: true, revocation: "done" });
  });
  it("a missing, forged or expired intent: refused before anything runs", async () => {
    for (const intent of [undefined, "", "forged", 42]) {
      const { deps, log } = world();
      expect(await closeAppleAccount({ method: "apple", code: "C", intent } as unknown as AppleDeletionInput, deps)).toEqual({ closed: false, code: "intent_invalid" });
      expect(log).toEqual([]);
    }
  });
});

describe("first review, point 4", () => {
  it("stale Supabase session: refused before Apple is contacted; nothing closed or revoked", async () => {
    const { deps, log } = world({ recent: false });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "reauth_required" });
    expect(log).toEqual(["subs", "recent"]);
  });
  it("stale session that slips past the read-only check: the database still refuses at close; nothing revoked", async () => {
    const { deps, log } = world({ close: { ok: false, code: "reauth_required" } });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "reauth_required" });
    expect(log).not.toContain("revoke");
  });
  it("Apple cancelled (no code): nothing happens; the fallback then closes with an alert and no revocation", async () => {
    const a = world();
    expect(await closeAppleAccount({ method: "apple", code: "", intent: "intent-A" }, a.deps)).toEqual({ closed: false, code: "apple_code_missing" });
    expect(a.log).toEqual(["subs", "recent"]);
    const b = world();
    expect(await closeAppleAccount(FALLBACK, b.deps)).toEqual({ closed: true, revocation: "skipped" });
    expect(steps(b.log)).toEqual(["subs", "recent", "close", "mark:skipped", "process"]);
    expect(b.alerts).toEqual([["appleRevocationSkipped", "fallback"]]);
  });
  it("a token that fails verification: refused and alerted (possible forgery), nothing closed", async () => {
    const { deps, log, alerts } = world({ verify: { ok: false, code: "bad_signature" } });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "apple_identity_unverified" });
    expect(log).not.toContain("close");
    expect(alerts).toEqual([["appleIdentityRejected", "bad_signature"]]);
  });
  it("provider outage at the exchange or at Apple's keys: nothing closed; the fallback still works", async () => {
    for (const w of [{ exchange: { ok: false, code: "apple_unavailable" } as ExchangeResult }, { exchange: "throw" as const },
                     { verify: { ok: false, code: "apple_unavailable" } as VerifyResult }, { verify: "throw" as const }]) {
      const { deps, log } = world(w);
      expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "apple_unavailable" });
      expect(log).not.toContain("close");
    }
    expect(await closeAppleAccount(FALLBACK, world({ exchange: "throw" }).deps)).toEqual({ closed: true, revocation: "skipped" });
  });
  it("a rejected or reused code: nothing closed", async () => {
    const { deps, log } = world({ exchange: { ok: false, code: "code_rejected" } });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "apple_code_rejected" });
    expect(log).not.toContain("close");
  });
  it("revocation refused or Apple down after closure → still closed, marked, processed, alerted", async () => {
    for (const revoke of [{ ok: false, code: "revoke_failed" } as RevokeResult, { ok: false, code: "apple_unavailable" } as RevokeResult, "throw" as const]) {
      const { deps, log, alerts } = world({ revoke });
      expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: true, revocation: "failed" });
      expect(steps(log)).toEqual(["subs", "recent", "exchange:CODE-1", "verify", "close", "revoke", "mark:failed", "process"]);
      expect(alerts.map((a) => a[0])).toEqual(["appleRevokeFailed"]);
    }
  });
  it("an account with email and Apple sign-in: the Apple identity is matched, the email identity is ignored", async () => {
    const user = { identities: [
      { provider: "email", provider_id: A, identity_data: { sub: A, email: "x@example.com" } },
      { provider: "apple", provider_id: "apple-A", identity_data: { sub: "apple-A" } },
    ] };
    expect(appleSubsFromUser(user)).toEqual(["apple-A"]);
    expect(await closeAppleAccount(APPLE, world({ subs: appleSubsFromUser(user) }).deps)).toEqual({ closed: true, revocation: "done" });
    expect(await closeAppleAccount(APPLE, world({ subs: appleSubsFromUser(user), verify: { ok: true, sub: A } }).deps))
      .toEqual({ closed: false, code: "wrong_apple_account" });
  });
  it("an account without an Apple identity is not handled here (the ordinary deletion applies)", async () => {
    const { deps, log } = world({ subs: appleSubsFromUser({ identities: [{ provider: "email", identity_data: { sub: A } }] }) });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "not_apple_account" });
    expect(log).toEqual(["subs"]);
  });
});

describe("second review: revoke before processing; a committed closure with a lost answer", () => {
  it("processing that never returns cannot prevent the revocation (it already happened)", async () => {
    const { deps, log } = world({ process: "hang" });
    void closeAppleAccount(APPLE, deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(["subs", "recent", "exchange:CODE-1", "verify", "close", "revoke", "mark:done", "process"]);
  });
  it("processing failing after closure: still closed and revoked", async () => {
    expect(await closeAppleAccount(APPLE, world({ process: "throw" }).deps)).toEqual({ closed: true, revocation: "done" });
  });
  it("REGRESSION: committed closure, lost response → the deletion record says closed → revoke, mark, process", async () => {
    for (const close of [{ ok: "unknown" } as CloseOutcome, "throw" as const]) {
      const { deps, log, alerts } = world({ close, closureStatus: "closed" });
      expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: true, revocation: "done" });
      expect(log).toEqual(["subs", "recent", "exchange:CODE-1", "verify", "close", "status", "revoke", "mark:done", "process"]);
      expect(alerts).toEqual([]);
    }
  });
  it("lost response and a readable record with no closure yet → still unknown (the request may still commit), nothing revoked", async () => {
    const { deps, log, alerts } = world({ close: "throw", closureStatus: "open" });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: "unknown", code: "close_result_unknown" });
    expect(log).not.toContain("revoke");
    expect(alerts).toEqual([["appleCloseResultUnknown", "no_closure_seen"]]);
  });
  it("a definite database refusal or error is not ambiguous: the record is not consulted", async () => {
    const { deps, log } = world({ close: { ok: false, code: "failed" } });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "failed" });
    expect(log).not.toContain("status");
  });
});

describe("third review, point 2: a failed lookup is 'unknown', never proof that nothing changed", () => {
  it("closureFromRecords: a failed lookup (null/undefined) is unknown; an empty result is open; closed states are closed", () => {
    expect(closureFromRecords(null)).toBe("unknown");
    expect(closureFromRecords(undefined)).toBe("unknown");
    expect(closureFromRecords([])).toBe("open");
    for (const status of ["closing", "closed", "held", "data_removed", "done"]) expect(closureFromRecords([{ status }])).toBe("closed");
    for (const status of ["requested", "cancelled"]) expect(closureFromRecords([{ status }])).toBe("open");
    expect(closureFromRecords([{ status: "cancelled" }, { status: "closing" }])).toBe("closed");
  });
  it("lost response + lookup FAILED (unknown, thrown or timed out) → close_result_unknown, alert 'record_unreadable', no revocation", async () => {
    vi.useFakeTimers();
    for (const closureStatus of ["unknown" as const, "throw" as const, "hang" as const]) {
      for (const input of [APPLE, FALLBACK]) {
        const { deps, log, alerts } = world({ close: "throw", closureStatus });
        const p = closeAppleAccount(input, deps);
        await vi.advanceTimersByTimeAsync(LIMITS.status + LIMITS.bookkeeping);
        expect(await p).toEqual({ closed: "unknown", code: "close_result_unknown" });
        expect(log).not.toContain("revoke");
        expect(alerts).toEqual([["appleCloseResultUnknown", "record_unreadable"]]);
      }
    }
  });
  it("…versus a lookup that worked and found NO record: told apart ('no_closure_seen'), and still never 'nothing changed'", async () => {
    const { deps, alerts } = world({ close: "throw", closureStatus: closureFromRecords([]) });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: "unknown", code: "close_result_unknown" });
    expect(alerts).toEqual([["appleCloseResultUnknown", "no_closure_seen"]]);
  });
});

describe("third review, point 3: slow responses and time-outs never hold up the deletion", () => {
  it("a closure that never answers is treated as a lost answer after its limit (then the record decides)", async () => {
    vi.useFakeTimers();
    const { deps, log, signals } = world({ close: "hang", closureStatus: "closed" });
    const p = closeAppleAccount(APPLE, deps);
    await vi.advanceTimersByTimeAsync(LIMITS.close);
    expect(await p).toEqual({ closed: true, revocation: "done" });
    expect(signals.close.aborted).toBe(true);
    expect(log).toEqual(["subs", "recent", "exchange:CODE-1", "verify", "close", "status", "revoke", "mark:done", "process"]);
  });
  it("a revocation that never answers: failed after its limit, alerted, and the processing starts", async () => {
    vi.useFakeTimers();
    const { deps, log, alerts, signals } = world({ revoke: "hang" });
    const p = closeAppleAccount(APPLE, deps);
    await vi.advanceTimersByTimeAsync(LIMITS.revoke);
    expect(await p).toEqual({ closed: true, revocation: "failed" });
    expect(signals.revoke.aborted).toBe(true);
    expect(alerts.map((a) => a[0])).toEqual(["appleRevokeFailed"]);
    expect(log).toContain("process");
  });
  it("a marker write that hangs delays the processing by at most its limit, and is aborted", async () => {
    vi.useFakeTimers();
    const { deps, log, signals } = world({ mark: "hang" });
    const p = closeAppleAccount(APPLE, deps);
    await vi.advanceTimersByTimeAsync(LIMITS.bookkeeping - 1);
    expect(log).not.toContain("process");
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ closed: true, revocation: "done" });
    expect(log).toContain("process");
    expect(signals["mark:done"].aborted).toBe(true);
  });
  it("fourth review: a marker write that FAILS is alerted, never taken as recorded; the processing still runs", async () => {
    const { deps, log, alerts } = world({ mark: "throw" });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: true, revocation: "done" });
    expect(alerts).toEqual([["appleRevocationMarkFailed", "done_error"]]);
    expect(log).toContain("process");
  });
  it("…and a marker write that times out is alerted as a time-out", async () => {
    vi.useFakeTimers();
    const { deps, alerts } = world({ mark: "hang" });
    const p = closeAppleAccount(FALLBACK, deps);
    await vi.advanceTimersByTimeAsync(3 * LIMITS.bookkeeping);
    expect(await p).toEqual({ closed: true, revocation: "skipped" });
    expect(alerts).toEqual([["appleRevocationSkipped", "fallback"], ["appleRevocationMarkFailed", "skipped_timeout"]]);
  });
  it("monitoring that hangs or fails delays nothing beyond its limit, on every alert path", async () => {
    vi.useFakeTimers();
    for (const alert of ["hang" as const, "throw" as const]) {
      for (const w of [{ revoke: { ok: false, code: "revoke_failed" } as RevokeResult }, {}]) {
        const { deps, log } = world({ ...w, alert });
        const p = closeAppleAccount("revoke" in w ? APPLE : FALLBACK, deps);
        await vi.advanceTimersByTimeAsync(2 * LIMITS.bookkeeping);
        expect((await p).closed).toBe(true);
        expect(log).toContain("process");
      }
    }
  });
  it("Apple hanging before closure: apple_unavailable after the limit, nothing closed", async () => {
    vi.useFakeTimers();
    for (const w of [{ exchange: "hang" as const }, { verify: "hang" as const }]) {
      const { deps, log } = world(w);
      const p = closeAppleAccount(APPLE, deps);
      await vi.advanceTimersByTimeAsync(LIMITS.apple);
      expect(await p).toEqual({ closed: false, code: "apple_unavailable" });
      expect(log).not.toContain("close");
    }
  });
  it("lookups hanging: nothing happens after the limit", async () => {
    vi.useFakeTimers();
    for (const [w, code] of [[{ subs: "hang" as const }, "identity_lookup_failed"], [{ recent: "hang" as const }, "failed"]] as const) {
      const { deps, log } = world(w);
      const p = closeAppleAccount(APPLE, deps);
      await vi.advanceTimersByTimeAsync(LIMITS.lookup);
      expect(await p).toEqual({ closed: false, code });
      expect(log).not.toContain("close");
    }
  });
});

describe("the existing deletion rules are untouched", () => {
  it("staff, admin and paused-processing refusals come from the database and stop everything after them", async () => {
    for (const code of ["staff_role", "admin_role", "processing_unavailable"]) {
      for (const input of [APPLE, FALLBACK]) {
        const { deps, log, alerts } = world({ close: { ok: false, code } });
        expect(await closeAppleAccount(input, deps)).toEqual({ closed: false, code });
        expect(log).not.toContain("revoke");
        expect(alerts).toEqual([]);
      }
    }
  });
  it("the fallback needs the same recent sign-in (the email code); it never skips the database's check", async () => {
    const { deps, log } = world({ recent: false });
    expect(await closeAppleAccount(FALLBACK, deps)).toEqual({ closed: false, code: "reauth_required" });
    expect(log).toEqual(["subs", "recent"]);
  });
  it("identity lookup or recency read failing: nothing happens", async () => {
    expect(await closeAppleAccount(APPLE, world({ subs: null }).deps)).toEqual({ closed: false, code: "identity_lookup_failed" });
    expect(await closeAppleAccount(APPLE, world({ subs: "throw" }).deps)).toEqual({ closed: false, code: "identity_lookup_failed" });
    expect(await closeAppleAccount(APPLE, world({ recent: null }).deps)).toEqual({ closed: false, code: "failed" });
  });
});

describe("server-side identity only", () => {
  it("an Apple user id sent by the client is ignored", async () => {
    const forged = { ...APPLE, sub: "apple-B", appleSub: "apple-B" } as unknown as AppleDeletionInput;
    expect(await closeAppleAccount(forged, world({ verify: { ok: true, sub: "apple-B" } }).deps)).toEqual({ closed: false, code: "wrong_apple_account" });
  });
  it("identities: only provider 'apple', sub from identity_data (provider_id as fallback), duplicates once, junk ignored", () => {
    expect(appleSubsFromUser({ identities: [
      { provider: "apple", provider_id: "A1", identity_data: null },
      { provider: "apple", provider_id: "A1", identity_data: { sub: "A1" } },
      { provider: "google", identity_data: { sub: "G1" } },
      { provider: "apple", identity_data: { sub: 5 } },
    ] })).toEqual(["A1"]);
    expect(appleSubsFromUser(null)).toEqual([]);
  });
  it("the mark read by the deletion processing: Apple link and recorded outcome from the sign-in record", () => {
    const apple = { provider: "apple", identity_data: { sub: "A1" } };
    expect(appleLinkState({ identities: [apple], app_metadata: { apple_revocation: "done" } })).toEqual({ apple: true, marked: true });
    expect(appleLinkState({ identities: [apple], app_metadata: {} })).toEqual({ apple: true, marked: false });
    expect(appleLinkState(null)).toEqual({ apple: false, marked: false });
  });
  it("an unknown method is refused before anything runs", async () => {
    const { deps, log } = world();
    expect(await closeAppleAccount({ method: "skip", intent: "intent-A" } as unknown as AppleDeletionInput, deps)).toEqual({ closed: false, code: "bad_request" });
    expect(log).toEqual([]);
  });
});
