// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The payment route looks a payment up only among the caller's own, where the caller is whoever
 * authenticateRequest verified — never an id from the request body.
 */
const filters: Array<[string, unknown]> = [];
const single = vi.fn(async () => ({ data: null, error: { message: "no row" } }));
const builder = { select: () => builder, eq: (c: string, v: unknown) => { filters.push([c, v]); return builder; }, single };
let auth: unknown = { ok: true, via: "bearer", user: { id: "player-a" }, supabase: { from: () => builder } };
vi.mock("@/lib/supabase/request", () => ({ authenticateRequest: async () => auth }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/payments", () => ({ getProvider: () => ({ name: "simulated" }) }));

const { POST } = await import("./route");
const call = (body: unknown) => POST(new Request("https://x.test/api/pay/simulate", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  filters.length = 0;
  auth = { ok: true, via: "bearer", user: { id: "player-a" }, supabase: { from: () => builder } };
});

describe("POST /api/pay/simulate", () => {
  it("only finds a payment belonging to the verified caller", async () => {
    const res = await call({ paymentId: "pay-of-b", profile_id: "player-b", user_id: "player-b" });
    expect(filters).toContainEqual(["profile_id", "player-a"]);
    expect(filters).not.toContainEqual(["profile_id", "player-b"]);
    expect(res.status).toBe(404);
  });

  it("refuses an unverified caller before touching any payment", async () => {
    auth = { ok: false, status: 401, error: "invalid_authorization" };
    const res = await call({ paymentId: "pay-1" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_authorization" });
    expect(filters).toHaveLength(0);
  });
});
