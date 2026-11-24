// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { reconcileCharges, runPaymentReconciliation } from "./reconcile";
import { verifyAndRecord, UNKNOWN_GRACE_MINUTES, type Rpc } from "./attempts";
import { FakeGateway } from "./testing/fakeGateway";

/**
 * M12.2 reconciliation logic with a fake database answer per call. What the database does with each call is tested
 * against PostgreSQL (supabase/tests/api/gateway.mjs and the SQL suites); here: what is sent, what is counted, and
 * that conflicts and outages surface as problems, never as success.
 */
const A1 = "0d000000-0000-4000-8000-000000000001", A2 = "0d000000-0000-4000-8000-000000000002";
function db(answer: (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = { rpc: async (fn, args = {}) => { calls.push({ fn, args }); return { data: null, error: null, ...answer(fn, args) }; } };
  return { rpc, calls };
}

describe("reconcileCharges", () => {
  it("hands every charge of the provider's list to reconcile_provider_charge, with the provider's own name", async () => {
    const g = new FakeGateway(() => 0);
    const { rpc, calls } = db(() => ({ data: "confirmed" }));
    const s = await reconcileCharges(rpc, g, [{ externalRef: A1, providerRef: "G-1", amount: 1, currency: "USD" }, { externalRef: null, providerRef: "G-2", amount: 2, currency: "USD" }]);
    expect(calls).toEqual([
      { fn: "reconcile_provider_charge", args: { p_provider: "whish", p_external_ref: A1, p_provider_ref: "G-1", p_amount: 1, p_currency: "USD" } },
      { fn: "reconcile_provider_charge", args: { p_provider: "whish", p_external_ref: "", p_provider_ref: "G-2", p_amount: 2, p_currency: "USD" } },
    ]);
    expect(s).toEqual({ seen: 2, outcomes: { confirmed: 2 }, conflicts: 0, failures: {} });
  });
  it("conflicting evidence is counted as a conflict, never as an outcome", async () => {
    const answers = ["charge_evidence_conflict", "attempt_evidence_conflict", "duplicate_provider_ref", "permission denied for function x"];
    const { rpc } = db(() => ({ error: { message: answers.shift()! } }));
    const charges = [1, 2, 3, 4].map((n) => ({ externalRef: A1, providerRef: `G-${n}`, amount: 1, currency: "USD" }));
    expect(await reconcileCharges(rpc, new FakeGateway(), charges)).toEqual({ seen: 4, outcomes: {}, conflicts: 3, failures: { record_failed: 1 } });
  });
  it("stops starting new charges once past its deadline", async () => {
    const { rpc, calls } = db(() => ({ data: "unmatched" }));
    const s = await reconcileCharges(rpc, new FakeGateway(), [{ externalRef: null, providerRef: "G-1", amount: 1, currency: "USD" }], { deadline: Date.now() - 1 });
    expect([calls.length, s.failures]).toEqual([0, { out_of_time: 1 }]);
  });
});

describe("runPaymentReconciliation", () => {
  it("sweeps, then reconciles the provider's list; a clean run has no problems", async () => {
    const g = new FakeGateway(() => 0);
    const { rpc, calls } = db((fn) => (fn === "attempts_to_check" ? { data: [] } : { data: "already_recorded" }));
    g.foreignCharge();
    const s = await runPaymentReconciliation(rpc, g, { now: new Date(0) });
    expect(calls.map((c) => c.fn)).toEqual(["attempts_to_check", "reconcile_provider_charge"]);
    expect(s.problems).toEqual([]);
  });
  it("a conflict, an unreadable list or an unreadable sweep list are problems", async () => {
    const g = new FakeGateway(() => 0);
    g.foreignCharge();
    let s = await runPaymentReconciliation(db((fn) => (fn === "attempts_to_check" ? { data: [] } : { error: { message: "charge_evidence_conflict" } })).rpc, g);
    expect(s.problems).toEqual(["conflicts"]);
    g.listDown = true;
    s = await runPaymentReconciliation(db(() => ({ error: { message: "boom" } })).rpc, g);
    expect(s.problems).toEqual(["sweep_list", "charge_list"]);
  });
  it("a provider without a charge list: sweep only", async () => {
    const g = new FakeGateway(() => 0);
    (g as { listCharges?: unknown }).listCharges = undefined;
    const s = await runPaymentReconciliation(db(() => ({ data: [] })).rpc, g);
    expect([s.reconcile, s.problems]).toEqual([null, []]);
  });
});

describe("a provider that has never heard of an attempt (\"unknown\")", () => {
  const g = new FakeGateway(() => 0);
  it(`is "pending" for ${UNKNOWN_GRACE_MINUTES} minutes, then recorded as expired; without the attempt's age, always pending`, async () => {
    const created = new Date("2026-12-01T10:00:00Z");
    for (const [minutes, want] of [[1, "pending"], [UNKNOWN_GRACE_MINUTES - 1, "pending"], [UNKNOWN_GRACE_MINUTES + 1, "expired"]] as const) {
      const { rpc, calls } = db(() => ({ data: "x" }));
      await verifyAndRecord(rpc, g, A2, { createdAt: created, now: new Date(created.getTime() + minutes * 60_000) });
      expect(calls[0].args).toEqual({ p_attempt: A2, p_result: want });
    }
    const { rpc, calls } = db(() => ({ data: "x" }));
    await verifyAndRecord(rpc, g, A2, { now: new Date("2030-01-01") });
    expect(calls[0].args.p_result).toBe("pending");
  });
});
