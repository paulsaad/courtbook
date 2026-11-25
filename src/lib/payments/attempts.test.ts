// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { paymentCode, recordEvidence, sweepOpenAttempts, verifyAndRecord, type Rpc } from "./attempts";
import type { AttemptStatus, PaymentProvider } from "./provider";

/**
 * Provider-independent attempt handling (M12.1). The database's idempotence is tested in SQL
 * (supabase/tests/payments/fee_online_tests.sql, races with FEE=1); these check what the server sends it, and that
 * nothing but fixed codes comes back out.
 */
const A1 = "0a000000-0000-4000-8000-000000000001", A2 = "0a000000-0000-4000-8000-000000000002", A3 = "0a000000-0000-4000-8000-000000000003";

function fakeDb(answer: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { message?: string; code?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const db: Rpc = { rpc: async (fn, args = {}) => { calls.push({ fn, args }); return { data: null, error: null, ...answer(fn, args) }; } };
  return { db, calls };
}
function provider(statuses: Record<string, AttemptStatus | "throw">, name: PaymentProvider["name"] = "whish"): PaymentProvider {
  return {
    name, start: vi.fn(), verify: vi.fn(), refund: vi.fn(), startAttempt: vi.fn(),
    attemptStatus: vi.fn(async (id: string) => { const s = statuses[id]; if (s === "throw" || !s) throw new Error("down: secret details"); return s; }),
  } as unknown as PaymentProvider;
}

describe("verifyAndRecord", () => {
  it("a success is recorded with the provider's own evidence (reference, amount, currency)", async () => {
    const { db, calls } = fakeDb(() => ({ data: "confirmed" }));
    const r = await verifyAndRecord(db, provider({ [A1]: { state: "succeeded", evidence: { providerRef: "W-1", amount: 1, currency: "USD" } } }), A1);
    expect(r).toEqual({ ok: true, outcome: "confirmed" });
    expect(calls).toEqual([{ fn: "record_attempt_result", args: { p_attempt: A1, p_result: "succeeded", p_provider_ref: "W-1", p_amount: 1, p_currency: "USD" } }]);
  });
  it.each(["failed", "expired", "pending"] as const)("a %s answer records only that state (no amount, no reference)", async (state) => {
    const { db, calls } = fakeDb(() => ({ data: state }));
    await verifyAndRecord(db, provider({ [A1]: { state } }), A1);
    expect(calls[0].args).toEqual({ p_attempt: A1, p_result: state });
  });
  it("a provider that cannot be reached records nothing", async () => {
    const { db, calls } = fakeDb(() => ({}));
    expect(await verifyAndRecord(db, provider({ [A1]: "throw" }), A1)).toEqual({ ok: false, code: "provider_unavailable" });
    expect(calls).toEqual([]);
  });
  it("a database refusal comes back as a known code, never as its text", async () => {
    const { db } = fakeDb(() => ({ error: { message: "duplicate key value violates unique constraint \"x\" DETAIL: Key (id)=(…)" } }));
    expect(await verifyAndRecord(db, provider({ [A1]: { state: "pending" } }), A1)).toEqual({ ok: false, code: "payment_record_failed" });
    const { db: db2 } = fakeDb(() => ({ error: { message: "attempt_evidence_conflict" } }));
    expect(await verifyAndRecord(db2, provider({ [A1]: { state: "pending" } }), A1)).toEqual({ ok: false, code: "attempt_evidence_conflict" });
  });
  it("recordEvidence passes the simulated provider's immediate evidence the same way", async () => {
    const { db, calls } = fakeDb(() => ({ data: "confirmed" }));
    await recordEvidence(db, A1, { providerRef: `SIM-${A1}`, amount: 1, currency: "USD" });
    expect(calls[0]).toEqual({ fn: "record_attempt_result", args: { p_attempt: A1, p_result: "succeeded", p_provider_ref: `SIM-${A1}`, p_amount: 1, p_currency: "USD" } });
  });
});

describe("paymentCode", () => {
  it("passes known refusals and hides everything else", () => {
    expect(paymentCode({ message: "hold_expired" }, "x")).toBe("hold_expired");
    expect(paymentCode({ message: "permission denied for function record_attempt_result" }, "x")).toBe("x");
    expect(paymentCode(null, "x")).toBe("x");
  });
});

describe("sweepOpenAttempts", () => {
  it("asks about each open attempt of the configured provider, skips others, and counts outcomes", async () => {
    const recorded: string[] = [];
    const { db, calls } = fakeDb((fn, args) => {
      if (fn === "attempts_to_check") return { data: [{ attempt_id: A1, provider: "whish" }, { attempt_id: A2, provider: "areeba" }, { attempt_id: A3, provider: "whish" }] };
      recorded.push(String(args.p_attempt));
      return { data: args.p_result === "succeeded" ? "late" : args.p_result };
    });
    const p = provider({ [A1]: { state: "succeeded", evidence: { providerRef: "W-9", amount: 1, currency: "USD" } }, [A3]: { state: "expired" } });
    const s = await sweepOpenAttempts(db, p, { minAgeSeconds: 120, maxAgeHours: 48, limit: 50 });
    expect(calls[0]).toEqual({ fn: "attempts_to_check", args: { p_min_age: "120 seconds", p_max_age: "48 hours", p_limit: 50 } });
    expect(recorded).toEqual([A1, A3]);
    expect(s).toEqual({ checked: 2, outcomes: { late: 1, expired: 1 }, failures: {} });
  });
  it("running it twice asks twice; the database decides it is the same charge (already_recorded)", async () => {
    let n = 0;
    const { db } = fakeDb((fn) => (fn === "attempts_to_check" ? { data: [{ attempt_id: A1, provider: "whish" }] } : { data: n++ === 0 ? "confirmed" : "already_recorded" }));
    const p = provider({ [A1]: { state: "succeeded", evidence: { providerRef: "W-1", amount: 1, currency: "USD" } } });
    const one = await sweepOpenAttempts(db, p, { minAgeSeconds: 60, maxAgeHours: 24, limit: 10 });
    const two = await sweepOpenAttempts(db, p, { minAgeSeconds: 60, maxAgeHours: 24, limit: 10 });
    expect([one.outcomes, two.outcomes]).toEqual([{ confirmed: 1 }, { already_recorded: 1 }]);
  });
  it("an attempt whose start timed out (still 'starting') and whose callback was lost is found and confirmed by the sweeper", async () => {
    const { db, calls } = fakeDb((fn, args) => (fn === "attempts_to_check" ? { data: [{ attempt_id: A1, provider: "whish", status: "starting" }] } : { data: args.p_result === "succeeded" ? "confirmed" : "?" }));
    const s = await sweepOpenAttempts(db, provider({ [A1]: { state: "succeeded", evidence: { providerRef: "W-t", amount: 1, currency: "USD" } } }), { minAgeSeconds: 60, maxAgeHours: 24, limit: 10 });
    expect(s.outcomes).toEqual({ confirmed: 1 });
    expect(calls[1].args).toEqual({ p_attempt: A1, p_result: "succeeded", p_provider_ref: "W-t", p_amount: 1, p_currency: "USD" });
  });
  it("a provider outage is counted, not thrown", async () => {
    const { db } = fakeDb((fn) => (fn === "attempts_to_check" ? { data: [{ attempt_id: A1, provider: "whish" }] } : {}));
    expect(await sweepOpenAttempts(db, provider({ [A1]: "throw" }), { minAgeSeconds: 0, maxAgeHours: 1, limit: 1 })).toEqual({ checked: 1, outcomes: {}, failures: { provider_unavailable: 1 } });
  });
});
