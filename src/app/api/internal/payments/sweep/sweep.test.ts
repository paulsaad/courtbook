// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The scheduled reconciliation route (M12.2): who may call it, what it answers (counts only), when it says 500. */
let answers: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }>;
const reported: unknown[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => ({ data: null, error: null, ...(answers[fn]?.(args) ?? {}) }) }) }));
vi.mock("@/lib/report", () => ({ report: async (...a: unknown[]) => { reported.push(a); } }));
const { FakeGateway } = await import("@/lib/payments/testing/fakeGateway");
const gateway = new FakeGateway(() => Date.now());
vi.mock("@/lib/payments", () => ({ getProvider: () => gateway }));
const route = await import("./route");

const SECRET = "s".repeat(40);
const req = (auth?: string) => new Request("https://x.example/api/internal/payments/sweep", { headers: auth ? { authorization: auth } : {} });
const A1 = "0d000000-0000-4000-8000-000000000001";
const HEALTHY = { other_provider_attempts: 0, overdue_attempts: 0, oldest_unresolved: null, open_issues: 0, reconciled_until: null as string | null };
beforeEach(() => { answers = { attempts_to_check: () => ({ data: [] }), payment_reconciliation_health: () => ({ data: [{ ...HEALTHY, reconciled_until: new Date(Date.now() - 60_000).toISOString() }] }), advance_reconciliation_watermark: () => ({ data: "t" }) }; reported.length = 0; process.env.CRON_SECRET = SECRET; gateway.foreign = []; gateway.pages.clear(); });

describe("GET /api/internal/payments/sweep", () => {
  it("no secret configured: 503; wrong secret: 401; nothing is done", async () => {
    delete process.env.CRON_SECRET;
    expect((await route.GET(req(`Bearer ${SECRET}`))).status).toBe(503);
    process.env.CRON_SECRET = SECRET;
    answers.attempts_to_check = () => { throw new Error("must not be called"); };
    expect((await route.GET(req("Bearer wrong"))).status).toBe(401);
    expect((await route.GET(req())).status).toBe(401);
  });
  it("a clean run: 200, counts only", async () => {
    answers.attempts_to_check = () => ({ data: [{ attempt_id: A1, provider: "whish", created_at: new Date(0).toISOString() }] });
    answers.record_attempt_result = () => ({ data: "pending" });
    answers.reconcile_provider_charge = () => ({ data: "unmatched" });
    gateway.foreignCharge(1, "USD", Date.now() - 1000);
    const res = await route.GET(req(`Bearer ${SECRET}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ checked: 1, skipped: 0, outcomes: { pending: 1 }, sweepFailures: {}, health: { otherProviderAttempts: 0, overdueAttempts: 0, openIssues: 0 },
      window: { advanced: true }, charges: { seen: 1, outcomes: { unmatched: 1 }, conflicts: 0, failures: {} } });
    expect(JSON.stringify(body)).not.toMatch(/0d000000|G-\d|X-\d/);
  });
  it("a conflict: 500 with the problem code, and an alert with a fixed message", async () => {
    answers.reconcile_provider_charge = () => ({ error: { message: "charge_evidence_conflict" } });
    answers.record_reconciliation_issue = () => ({ data: "issue" });
    gateway.foreignCharge(1, "USD", Date.now() - 1000);
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect([res.status, (await res.json()).problems]).toEqual([500, ["conflicts"]]);
    expect(reported).toEqual([["paymentConflict", "payment", { code: "conflicts" }]]);
  });
  it("no verified starting point for the charge list: 500 reconciliation_not_initialised (never a silent default)", async () => {
    answers.payment_reconciliation_health = () => ({ data: [{ ...HEALTHY, reconciled_until: null }] });
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect([res.status, (await res.json()).problems]).toEqual([500, ["reconciliation_not_initialised"]]);
  });
  it("an incomplete run (time budget) or a wrongly configured provider: 500, never a success", async () => {
    answers.payment_reconciliation_health = () => ({ data: [{ ...HEALTHY, other_provider_attempts: 2, reconciled_until: new Date().toISOString() }] });
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect([res.status, (await res.json()).problems]).toEqual([500, ["provider_mismatch"]]);
  });
});
