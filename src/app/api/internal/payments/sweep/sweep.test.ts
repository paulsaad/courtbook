// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The scheduled reconciliation route (M12.2): who may call it, what it answers (counts only), when it says 500. */
let answers: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }>;
const reported: unknown[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => ({ data: null, error: null, ...(answers[fn]?.(args) ?? {}) }) }) }));
vi.mock("@/lib/report", () => ({ report: async (...a: unknown[]) => { reported.push(a); } }));
const { FakeGateway } = await import("@/lib/payments/testing/fakeGateway");
const gateway = new FakeGateway(() => 0);
vi.mock("@/lib/payments", () => ({ getProvider: () => gateway }));
const route = await import("./route");

const SECRET = "s".repeat(40);
const req = (auth?: string) => new Request("https://x.example/api/internal/payments/sweep", { headers: auth ? { authorization: auth } : {} });
const A1 = "0d000000-0000-4000-8000-000000000001";
beforeEach(() => { answers = { attempts_to_check: () => ({ data: [] }) }; reported.length = 0; process.env.CRON_SECRET = SECRET; gateway.foreign = []; gateway.pages.clear(); });

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
    gateway.foreignCharge();
    const res = await route.GET(req(`Bearer ${SECRET}`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ checked: 1, outcomes: { pending: 1 }, sweepFailures: {}, charges: { seen: 1, outcomes: { unmatched: 1 }, conflicts: 0, failures: {} } });
    expect(JSON.stringify(body)).not.toMatch(/0d000000|G-\d|X-\d/);
  });
  it("a conflict: 500 with the problem code, and an alert with a fixed message", async () => {
    answers.reconcile_provider_charge = () => ({ error: { message: "charge_evidence_conflict" } });
    gateway.foreignCharge();
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect([res.status, (await res.json()).problems]).toEqual([500, ["conflicts"]]);
    expect(reported).toEqual([["paymentConflict", "payment", { code: "conflicts" }]]);
  });
});
