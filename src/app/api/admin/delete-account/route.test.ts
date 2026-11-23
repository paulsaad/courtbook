import { afterEach, describe, expect, it, vi } from "vitest";

const SUBJECT = "d2000000-0000-4000-8000-000000000001";
const ADMIN = "d2000000-0000-4000-8000-000000000003";
type Rpc = { data?: unknown; error?: { message: string } | null };

/** Loads the route with a session client (rpc results per function) and a service client (deleteUser result). */
async function load(opts: { user?: string | null; rpc?: Record<string, Rpc>; del?: { error: { message: string; status?: number } | null } }) {
  vi.resetModules();
  const calls: string[] = [];
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: opts.user === null ? null : { id: opts.user ?? ADMIN } } }) },
      rpc: async (fn: string) => { calls.push(fn); return opts.rpc?.[fn] ?? { data: null, error: null }; },
    }),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: () => ({ auth: { admin: { deleteUser: async () => { calls.push("deleteUser"); return opts.del ?? { error: null }; } } } }),
  }));
  const { POST } = await import("./route");
  return { POST, calls };
}
const req = (body: unknown) => new Request("https://x.test/api/admin/delete-account", { method: "POST", body: JSON.stringify(body) });
afterEach(() => { vi.resetModules(); });

describe("admin delete-account route", () => {
  it("refuses a malformed subject before touching anything", async () => {
    const { POST, calls } = await load({});
    for (const b of [{}, { subject: "x" }, { subject: 5 }]) expect((await POST(req(b))).status).toBe(400);
    expect(calls).toEqual([]);
  });
  it("refuses when signed out", async () => {
    const { POST, calls } = await load({ user: null });
    expect((await POST(req({ subject: SUBJECT }))).status).toBe(401);
    expect(calls).toEqual([]);
  });
  it("refuses deleting your own account here", async () => {
    const { POST, calls } = await load({ user: SUBJECT });
    expect((await POST(req({ subject: SUBJECT }))).status).toBe(403);
    expect(calls).toEqual([]);
  });
  it("stops at the database step when the database refuses (no sign-in deletion)", async () => {
    for (const code of ["forbidden", "legal_hold", "staff_role", "no_open_request"]) {
      const { POST, calls } = await load({ rpc: { delete_account_data: { error: { message: code } } } });
      const res = await POST(req({ subject: SUBJECT }));
      expect(res.status).toBe(code === "forbidden" ? 403 : 409);
      expect(await res.json()).toEqual({ error: code, step: "data" });
      expect(calls).toEqual(["delete_account_data"]);
    }
  });
  it("runs the three steps in order and returns the summary", async () => {
    const { POST, calls } = await load({ rpc: { delete_account_data: { data: { bookings_anonymised: 4 }, error: null } } });
    const res = await POST(req({ subject: SUBJECT }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, summary: { bookings_anonymised: 4 } });
    expect(calls).toEqual(["delete_account_data", "deleteUser", "finish_account_deletion"]);
  });
  it("a failed sign-in deletion leaves the request to be resumed (no finish)", async () => {
    const { POST, calls } = await load({ del: { error: { message: "network", status: 500 } } });
    const res = await POST(req({ subject: SUBJECT }));
    expect(res.status).toBe(502);
    expect(calls).toEqual(["delete_account_data", "deleteUser"]);
  });
  it("an already deleted sign-in account (a resumed run) goes on to finish", async () => {
    const { POST, calls } = await load({ del: { error: { message: "User not found", status: 404 } } });
    expect((await POST(req({ subject: SUBJECT }))).status).toBe(200);
    expect(calls).toEqual(["delete_account_data", "deleteUser", "finish_account_deletion"]);
  });
  it("reports a refused finish without hiding it", async () => {
    const { POST } = await load({ rpc: { finish_account_deletion: { error: { message: "account_still_exists" } } } });
    const res = await POST(req({ subject: SUBJECT }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "account_still_exists", step: "finish" });
  });
});
