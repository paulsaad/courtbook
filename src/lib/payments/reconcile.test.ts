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
    const { rpc } = db((fn) => (fn === "record_reconciliation_issue" ? { data: "i" } : { error: { message: answers.shift()! } }));
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
  const NOW = new Date("2026-12-01T12:00:00Z");
  const clean: { other_provider_attempts: number; overdue_attempts: number; oldest_unresolved: string | null; open_issues: number; reconciled_until: string | null } =
    { other_provider_attempts: 0, overdue_attempts: 0, oldest_unresolved: null, open_issues: 0, reconciled_until: new Date(NOW.getTime() - 15 * 60_000).toISOString() };
  const world = (over: Partial<typeof clean> = {}, extra: Record<string, (a: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }> = {}) =>
    db((fn, args) => (extra[fn]?.(args) ?? (fn === "payment_reconciliation_health" ? { data: [{ ...clean, ...over }] } : fn === "attempts_to_check" ? { data: [] } : { data: "unmatched" })));

  it("a clean, complete run: sweep, health, one window from the watermark minus the overlap to now, watermark moved; no problems", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    const { rpc, calls } = world();
    const s = await runPaymentReconciliation(rpc, g, { now: NOW });
    expect(calls.map((c) => c.fn)).toEqual(["attempts_to_check", "payment_reconciliation_health", "advance_reconciliation_watermark"]);
    expect(g.listCalls).toEqual([{ since: NOW.getTime() - 75 * 60_000, until: NOW.getTime() }]);
    expect(calls[2].args).toEqual({ p_provider: "whish", p_until: NOW.toISOString() });
    expect(s.problems).toEqual([]);
  });
  it("REVIEW 1: running out of the time budget is a problem ('incomplete'), in the sweep and in the charge list", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    g.foreignCharge(1, "USD", NOW.getTime() - 60_000);
    const rows = [{ attempt_id: A1, provider: "whish", created_at: NOW.toISOString() }];
    const s = await runPaymentReconciliation(world({}, { attempts_to_check: () => ({ data: rows }) }).rpc, g, { now: NOW, budgetMs: -1 });
    expect(s.problems).toEqual(expect.arrayContaining(["incomplete", "reconciliation_behind"]));
    expect(s.window?.advanced).toBe(false);                                 // the window is read again next run
  });
  it("REVIEW 2: the charge list is read from the watermark, at most one window a run; behind = a problem until caught up", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    const old = new Date(NOW.getTime() - 5 * 24 * 3_600_000).toISOString();
    const s = await runPaymentReconciliation(world({ reconciled_until: old }).rpc, g, { now: NOW });
    expect(g.listCalls[0]).toEqual({ since: new Date(old).getTime() - 3_600_000, until: new Date(old).getTime() - 3_600_000 + 24 * 3_600_000 });
    expect(s.window?.advanced).toBe(true);
    expect(s.problems).toEqual(["reconciliation_behind"]);
  });
  it("REVIEW 2: first run ever starts 48 h back; a failed window does not move the watermark", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    let s = await runPaymentReconciliation(world({ reconciled_until: null }).rpc, g, { now: NOW });
    expect(g.listCalls[0].since).toBe(NOW.getTime() - 48 * 3_600_000);
    g.foreignCharge(1, "USD", NOW.getTime() - 60_000);
    const { rpc, calls } = world({}, { reconcile_provider_charge: () => ({ error: { message: "permission denied" } }) });
    s = await runPaymentReconciliation(rpc, g, { now: NOW });
    expect(calls.map((c) => c.fn)).not.toContain("advance_reconciliation_watermark");
    expect(s.problems).toEqual(expect.arrayContaining(["reconcile_failures", "reconciliation_behind"]));
  });
  it("REVIEW 2: overdue unresolved attempts and unresolved issues are problems on every run; every unresolved attempt is swept, however old", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    const { rpc, calls } = world({ overdue_attempts: 2, open_issues: 1 });
    const s = await runPaymentReconciliation(rpc, g, { now: NOW });
    expect(s.problems).toEqual(expect.arrayContaining(["overdue_attempts", "open_issues"]));
    expect(calls.find((c) => c.fn === "attempts_to_check")?.args.p_max_age).toBe(`${24 * 365 * 10} hours`);
  });
  it("REVIEW 2: a conflict is kept as an issue (record_reconciliation_issue) and reported", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    g.foreignCharge(1, "USD", NOW.getTime() - 60_000);
    const { rpc, calls } = world({}, { reconcile_provider_charge: () => ({ error: { message: "charge_evidence_conflict" } }) });
    const s = await runPaymentReconciliation(rpc, g, { now: NOW });
    expect(calls.find((c) => c.fn === "record_reconciliation_issue")?.args).toMatchObject({ p_provider: "whish", p_code: "charge_evidence_conflict", p_amount: 1, p_currency: "USD" });
    expect(s.problems).toEqual(["conflicts"]);
  });
  it("REVIEW 2: a conflict a person already resolved, seen again in a later window, is counted but not raised again", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    g.foreignCharge(1, "USD", NOW.getTime() - 60_000);
    const { rpc } = world({}, { reconcile_provider_charge: () => ({ error: { message: "charge_evidence_conflict" } }), record_reconciliation_issue: () => ({ data: "resolved" }) });
    const s = await runPaymentReconciliation(rpc, g, { now: NOW });
    expect([s.reconcile?.conflicts, s.reconcile?.outcomes, s.problems]).toEqual([0, { resolved_conflict: 1 }, []]);
  });
  it("REVIEW 4: attempts of another provider than the runner's are a problem, never skipped silently", async () => {
    const sim = new FakeGateway(() => NOW.getTime(), "simulated");
    const rows = [{ attempt_id: A1, provider: "whish", created_at: NOW.toISOString() }];
    let s = await runPaymentReconciliation(world({ other_provider_attempts: 1 }, { attempts_to_check: () => ({ data: rows }) }).rpc, sim, { now: NOW });
    expect([s.sweep.skipped, s.problems]).toEqual([1, ["provider_mismatch"]]);
    s = await runPaymentReconciliation(world({ other_provider_attempts: 3 }).rpc, sim, { now: NOW });   // resolved ones too, if recent
    expect(s.problems).toEqual(["provider_mismatch"]);
  });
  it("health or lists unreadable: problems; without the watermark the charge list waits", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    const s = await runPaymentReconciliation(db(() => ({ error: { message: "boom" } })).rpc, g, { now: NOW });
    expect(s.problems).toEqual(expect.arrayContaining(["health", "sweep_list", "incomplete"]));
    expect(g.listCalls).toEqual([]);
    g.listDown = true;
    expect((await runPaymentReconciliation(world().rpc, g, { now: NOW })).problems).toEqual(expect.arrayContaining(["charge_list", "reconciliation_behind"]));
  });
  it("a provider without a charge list: sweep and health only", async () => {
    const g = new FakeGateway(() => NOW.getTime());
    (g as { listCharges?: unknown }).listCharges = undefined;
    const s = await runPaymentReconciliation(world().rpc, g, { now: NOW });
    expect([s.reconcile, s.window, s.problems]).toEqual([null, null, []]);
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
