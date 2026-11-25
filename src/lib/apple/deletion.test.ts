import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { appleSubsFromUser, closeAppleAccount, type AppleDeletionDeps, type AppleDeletionInput } from "./deletion";
import { AppleToken, type ExchangeResult, type RevokeResult, type VerifyResult } from "./revoke";

/**
 * The whole E1 flow against fakes, with the order of every step recorded. Review 25 Nov, point 4: stale Supabase
 * session, Apple cancellation, incorrect Apple identity, provider outage, failure after closure, and an account with
 * more than one sign-in method; plus the fallback (point 3) and the server-side identity (point 5).
 */
type World = {
  subs?: string[] | null; recent?: boolean | null; exchange?: ExchangeResult | "throw"; verify?: VerifyResult | "throw";
  close?: { ok: true } | { ok: false; code: string } | "throw"; process?: "throw"; revoke?: RevokeResult | "throw";
};
function world(w: World = {}) {
  const log: string[] = [];
  const alerts: [string, string][] = [];
  const token = new AppleToken("RT-secret", "refresh_token");
  const ans = <T,>(step: string, v: T | "throw" | undefined, dflt: T) => { log.push(step); if (v === "throw") throw new Error("down"); return v === undefined ? dflt : v; };
  const deps: AppleDeletionDeps = {
    appleSubs: async () => ans("subs", w.subs, ["001234.apple-user"] as string[] | null),
    recentlyAuthenticated: async () => ans("recent", w.recent, true as boolean | null),
    exchange: async (code) => ans(`exchange:${code}`, w.exchange, { ok: true, idToken: "IDT", token } as ExchangeResult),
    verify: async () => ans("verify", w.verify, { ok: true, sub: "001234.apple-user" } as VerifyResult),
    close: async () => ans("close", w.close, { ok: true } as { ok: true } | { ok: false; code: string }),
    process: async () => { ans("process", w.process, undefined); },
    revoke: async (t) => { expect(t).toBe(token); return ans("revoke", w.revoke, { ok: true } as RevokeResult); },
    alert: async (event, code) => { alerts.push([event, code]); },
  };
  return { deps, log, alerts };
}
const APPLE: AppleDeletionInput = { method: "apple", code: "CODE-1" };
const FALLBACK: AppleDeletionInput = { method: "fallback" };

describe("closeAppleAccount: the happy path and its order", () => {
  it("identity → recency → exchange → verify → close → processing → revoke", async () => {
    const { deps, log, alerts } = world();
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: true, revocation: "done" });
    expect(log).toEqual(["subs", "recent", "exchange:CODE-1", "verify", "close", "process", "revoke"]);
    expect(alerts).toEqual([]);
  });
});

describe("review 25 Nov, point 4", () => {
  it("stale Supabase session: refused before Apple is contacted; nothing closed or revoked", async () => {
    const { deps, log } = world({ recent: false });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "reauth_required" });
    expect(log).toEqual(["subs", "recent"]);
  });
  it("stale session that slips past the read-only check: the database still refuses at close; nothing revoked", async () => {
    const { deps, log } = world({ close: { ok: false, code: "reauth_required" } });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "reauth_required" });
    expect(log).not.toContain("process");
    expect(log).not.toContain("revoke");
  });
  it("Apple cancelled (no code): nothing happens; the fallback then closes with an alert and no revocation", async () => {
    const a = world();
    expect(await closeAppleAccount({ method: "apple", code: "" }, a.deps)).toEqual({ closed: false, code: "apple_code_missing" });
    expect(a.log).toEqual(["subs", "recent"]);
    const b = world();
    expect(await closeAppleAccount(FALLBACK, b.deps)).toEqual({ closed: true, revocation: "skipped" });
    expect(b.log).toEqual(["subs", "recent", "close", "process"]);
    expect(b.alerts).toEqual([["appleRevocationSkipped", "fallback"]]);
  });
  it("incorrect Apple identity (a verified token for another Apple ID): nothing closed, nothing revoked", async () => {
    const { deps, log } = world({ verify: { ok: true, sub: "someone-else" } });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "wrong_apple_account" });
    expect(log).toEqual(["subs", "recent", "exchange:CODE-1", "verify"]);
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
  it("failure after closure: revocation refused or Apple down → still closed, processed, alerted", async () => {
    for (const revoke of [{ ok: false, code: "revoke_failed" } as RevokeResult, { ok: false, code: "apple_unavailable" } as RevokeResult, "throw" as const]) {
      const { deps, log, alerts } = world({ revoke });
      expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: true, revocation: "failed" });
      expect(log).toEqual(["subs", "recent", "exchange:CODE-1", "verify", "close", "process", "revoke"]);
      expect(alerts).toHaveLength(1);
      expect(alerts[0][0]).toBe("appleRevokeFailed");
    }
  });
  it("failure of the deletion processing after closure: still closed, and still revoked", async () => {
    const { deps, log } = world({ process: "throw" });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: true, revocation: "done" });
    expect(log).toContain("revoke");
  });
  it("an account with email and Apple sign-in: the Apple identity is matched, the email identity is ignored", async () => {
    const user = { identities: [
      { provider: "email", provider_id: "u-1", identity_data: { sub: "u-1", email: "x@example.com" } },
      { provider: "apple", provider_id: "001234.apple-user", identity_data: { sub: "001234.apple-user" } },
    ] };
    expect(appleSubsFromUser(user)).toEqual(["001234.apple-user"]);
    const { deps } = world({ subs: appleSubsFromUser(user) });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: true, revocation: "done" });
    // a verified token carrying the EMAIL identity's id is not accepted as the Apple identity
    expect(await closeAppleAccount(APPLE, world({ subs: appleSubsFromUser(user), verify: { ok: true, sub: "u-1" } }).deps))
      .toEqual({ closed: false, code: "wrong_apple_account" });
  });
  it("an account without an Apple identity is not handled here (the ordinary deletion applies); nothing else runs", async () => {
    const { deps, log } = world({ subs: appleSubsFromUser({ identities: [{ provider: "email", identity_data: { sub: "u-1" } }] }) });
    expect(await closeAppleAccount(APPLE, deps)).toEqual({ closed: false, code: "not_apple_account" });
    expect(log).toEqual(["subs"]);
  });
});

describe("the existing deletion rules are untouched (point 3)", () => {
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
    expect(await closeAppleAccount(APPLE, world({ subs: "throw" as never }).deps)).toEqual({ closed: false, code: "identity_lookup_failed" });
    expect(await closeAppleAccount(APPLE, world({ recent: null }).deps)).toEqual({ closed: false, code: "failed" });
  });
});

describe("point 5: the expected Apple identity is server-side only", () => {
  it("an Apple user id sent by the client is ignored", async () => {
    const forged = { method: "apple", code: "CODE-1", sub: "someone-else", appleSub: "someone-else" } as unknown as AppleDeletionInput;
    const { deps } = world({ verify: { ok: true, sub: "someone-else" } });
    expect(await closeAppleAccount(forged, deps)).toEqual({ closed: false, code: "wrong_apple_account" });
  });
  it("identities: only provider 'apple', sub from identity_data (provider_id as fallback), duplicates once, junk ignored", () => {
    expect(appleSubsFromUser({ identities: [
      { provider: "apple", provider_id: "A1", identity_data: null },
      { provider: "apple", provider_id: "A1", identity_data: { sub: "A1" } },
      { provider: "google", identity_data: { sub: "G1" } },
      { provider: "apple", identity_data: { sub: 5 } },
    ] })).toEqual(["A1"]);
    expect(appleSubsFromUser(null)).toEqual([]);
    expect(appleSubsFromUser({ identities: null })).toEqual([]);
  });
  it("an unknown method is refused before anything runs", async () => {
    const { deps, log } = world();
    expect(await closeAppleAccount({ method: "skip" } as unknown as AppleDeletionInput, deps)).toEqual({ closed: false, code: "bad_request" });
    expect(log).toEqual([]);
  });
});
