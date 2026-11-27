// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The three account-deletion routes: who may call them, which Supabase client runs which call (the person's own
 * session vs the service key), and what they answer. The pipeline itself is the real one (src/lib/deletion), running
 * against a mock service client that records every call.
 */
type Call = { client: "user" | "service"; fn: string; args?: unknown };
let calls: Call[];
let user: { id: string } | null;
let userRpc: Record<string, { data?: unknown; error?: { message: string; code?: string } | null }>;
let serviceRpc: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string; code?: string } | null }>;
let signOut: ReturnType<typeof vi.fn>;
let logout: ReturnType<typeof vi.fn>;   // auth.admin.signOut(jwt, "global"): the confirmed revocation (follow-up 27 Nov)
const reported: Array<[string, string, unknown]> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user } }),
      getSession: async () => ({ data: { session: user ? { access_token: "this-browser" } : null }, error: null }),
      admin: { signOut: (...a: unknown[]) => logout(...a) },
      signOut: (...a: unknown[]) => signOut(...a),
    },
    rpc: async (fn: string, args?: unknown) => { calls.push({ client: "user", fn, args }); return { data: null, error: null, ...(userRpc[fn] ?? {}) }; },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ client: "service", fn, args }); return { data: null, error: null, ...(serviceRpc[fn]?.(args) ?? {}) }; },
    auth: { admin: {
      updateUserById: async (id: string, attrs: unknown) => { calls.push({ client: "service", fn: "auth.ban", args: { id, attrs } }); return { error: null }; },
      deleteUser: async (id: string) => { calls.push({ client: "service", fn: "auth.delete", args: { id } }); return { error: null }; },
    } },
  }),
}));
vi.mock("@/lib/report", () => ({ report: async (k: string, a: string, d: unknown) => { reported.push([k, a, d]); } }));

const close = await import("./close/route");
const retry = await import("../internal/deletions/retry/route");
const adminRoute = await import("../admin/delete-account/route");

const ME = "d8600000-0000-4000-8000-000000000001";
const OTHER = "d8600000-0000-4000-8000-000000000002";
const SITE = "https://courtbook.example";
const SECRET = "s".repeat(40);

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { origin: SITE, "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
/** A claim that succeeds once, then the record is done: enough for the real pipeline to run A→E on the mock. */
function happyService() {
  let claimed = false;
  serviceRpc = {
    claim_deletion: () => claimed ? { data: { claimed: false, reason: "done" } } : (claimed = true, { data: { claimed: true, token: "tok", status: "closing", held_reason: null, banned: false, cancellations_done: false } }),
    deletions_due: () => ({ data: [] }),
    deletions_needing_attention: () => ({ data: [] }),
  };
}
beforeEach(() => {
  calls = []; user = { id: ME }; userRpc = {}; signOut = vi.fn(async () => ({ error: null })); reported.length = 0;
  happyService();
  delete process.env.CRON_SECRET;
});
// a separate hook (not the line above) so the staging website's version of this file merges without a conflict here
beforeEach(() => { logout = vi.fn(async () => ({ error: null })); });
const services = () => calls.filter((c) => c.client === "service").map((c) => c.fn);

describe("POST /api/account/close", () => {
  it("closes the signed-in person's own account, signs them out, then processes it with the service key", async () => {
    const res = await close.POST(post("/api/account/close", { confirm: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: true });
    expect(calls[0]).toEqual({ client: "user", fn: "close_my_account", args: { p_via: "web" } });
    // F2: closure ends every session, not just this browser; confirmed by the Auth server (follow-up 27 Nov)
    expect(logout).toHaveBeenCalledWith("this-browser", "global");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });   // this browser's cookies, after the confirmed revocation
    expect(reported).toEqual([]);
    expect(services()).toEqual(["claim_deletion", "auth.ban", "record_deletion_step", "record_deletion_step", "delete_account_data", "record_deletion_step", "auth.delete", "record_deletion_step", "finish_account_deletion"]);
    for (const c of calls.filter((c) => c.client === "service")) expect(JSON.stringify(c.args)).toContain(ME);
  });
  it("ignores any account named in the body: the subject is only ever the session's", async () => {
    await close.POST(post("/api/account/close", { confirm: true, subject: OTHER, p_subject: OTHER, user_id: OTHER }));
    expect(JSON.stringify(calls)).not.toContain(OTHER);
  });
  it("the person's session never calls a service-only function", async () => {
    await close.POST(post("/api/account/close", { confirm: true }));
    expect(calls.filter((c) => c.client === "user").map((c) => c.fn)).toEqual(["close_my_account"]);
  });
  it("signed out → 401, nothing called", async () => {
    user = null;
    const res = await close.POST(post("/api/account/close", { confirm: true }));
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });
  const bad: Array<[string, Request]> = [
    ["no Origin", post("/api/account/close", { confirm: true }, { origin: "" })],
    ["another site's Origin", post("/api/account/close", { confirm: true }, { origin: "https://evil.example" })],
    ["a cross-site fetch", post("/api/account/close", { confirm: true }, { "sec-fetch-site": "cross-site" })],
    ["a form post (not JSON)", post("/api/account/close", "confirm=true", { "content-type": "application/x-www-form-urlencoded" })],
    ["text/plain", post("/api/account/close", JSON.stringify({ confirm: true }), { "content-type": "text/plain" })],
  ];
  for (const [name, req] of bad) {
    it(`${name} → 403, nothing called`, async () => {
      const res = await close.POST(req);
      expect(res.status).toBe(403);
      expect(calls).toEqual([]);
      expect(signOut).not.toHaveBeenCalled();
    });
  }
  for (const body of [{}, { confirm: "true" }, { confirm: 1 }, [true], "not json"]) {
    it(`no explicit confirm (${JSON.stringify(body)}) → 400, nothing called`, async () => {
      const res = await close.POST(post("/api/account/close", body));
      expect(res.status).toBe(400);
      expect(calls).toEqual([]);
    });
  }
  it("signed in too long ago: 409 reauth_required, not signed out, nothing processed (the page asks for a code)", async () => {
    userRpc.close_my_account = { error: { message: "reauth_required", code: "P0001" } };
    const res = await close.POST(post("/api/account/close", { confirm: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "reauth_required" });
    expect(signOut).not.toHaveBeenCalled();
    expect(services()).toEqual([]);
  });
  it("staff/admin refused: 409 with the code, not signed out, nothing processed", async () => {
    userRpc.close_my_account = { error: { message: "staff_role", code: "P0001" } };
    const res = await close.POST(post("/api/account/close", { confirm: true }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "staff_role" });
    expect(signOut).not.toHaveBeenCalled();
    expect(services()).toEqual([]);
  });
  it("an unexpected close error: 500 'failed', reported by code only, nothing processed", async () => {
    userRpc.close_my_account = { error: { message: "something with Jana Probe in it", code: "XX000" } };
    const res = await close.POST(post("/api/account/close", { confirm: true }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed" });
    expect(reported).toEqual([["accountCloseFailed", "account", { code: "XX000" }]]);
    expect(services()).toEqual([]);
  });
  it("a failing later step still answers closed (the account IS closed), and is reported by code", async () => {
    serviceRpc.delete_account_data = () => ({ error: { message: "could not do it: Jana Probe", code: "XX000" } });
    const res = await close.POST(post("/api/account/close", { confirm: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: true });
    expect(reported).toEqual([["deletionStepFailed", "account", { code: "failed" }]]);
    expect(calls.find((c) => c.fn === "record_deletion_step" && (c.args as { p_step: string }).p_step === "failed")).toBeTruthy();
    expect(services()).not.toContain("auth.delete");
  });
  it("sign-out failing does not stop processing", async () => {
    signOut = vi.fn(async () => { throw new Error("network"); });
    const res = await close.POST(post("/api/account/close", { confirm: true }));
    expect(res.status).toBe(200);
    expect(services()).toContain("finish_account_deletion");
  });
  // follow-up 27 Nov: the old call (signOut scope "global") reported success on these without revoking anything
  for (const status of [401, 403, 404, 500]) {
    it(`revocation refused (${status}): reported, never assumed; this browser signed out; the ban still runs`, async () => {
      logout = vi.fn(async () => ({ error: { name: "AuthApiError", status } }));
      const res = await close.POST(post("/api/account/close", { confirm: true }));
      expect(await res.json()).toEqual({ closed: true });
      expect(reported).toContainEqual(["deletionStepFailed", "account", { code: "global_signout" }]);
      expect(signOut).toHaveBeenCalledWith({ scope: "local" });
      expect(services()).toContain("auth.ban");
    });
  }
  it("the report of an unconfirmed revocation itself failing never skips the ban (review nit of db8ac32)", async () => {
    logout = vi.fn(async () => ({ error: { name: "AuthApiError", status: 401 } }));
    // a monitoring outage: report() rejects for this one entry (done here, not in the mock above, so the staging
    // website's version of this file still merges without a conflict)
    const push = reported.push.bind(reported);
    reported.push = ((...rows: Array<[string, string, unknown]>) => {
      if ((rows[0]?.[2] as { code?: string } | undefined)?.code === "global_signout") throw new Error("sentry down");
      return push(...rows);
    }) as typeof reported.push;
    try {
      const res = await close.POST(post("/api/account/close", { confirm: true }));
      expect(await res.json()).toEqual({ closed: true });
      expect(services()).toContain("auth.ban");
      expect(services()).toContain("finish_account_deletion");
    } finally { delete (reported as { push?: unknown }).push; }   // back to Array.prototype.push
  });
  it("revocation unreachable (offline): reported; this browser signed out; the ban still runs", async () => {
    logout = vi.fn(async () => ({ error: { name: "AuthRetryableFetchError", status: 0 } }));
    await close.POST(post("/api/account/close", { confirm: true }));
    expect(reported).toContainEqual(["deletionStepFailed", "account", { code: "global_signout" }]);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(services()).toContain("auth.ban");
  });
  it("this browser's session already ended on the server (session_not_found): reported (the others were not asked); this browser cleared", async () => {
    logout = vi.fn(async () => ({ error: { name: "AuthSessionMissingError", status: 404 } }));
    await close.POST(post("/api/account/close", { confirm: true }));
    expect(reported).toContainEqual(["deletionStepFailed", "account", { code: "global_signout" }]);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("a second close while the first run holds the lease: still closed, nothing processed twice", async () => {
    serviceRpc.claim_deletion = () => ({ data: { claimed: false, reason: "leased" } });
    const res = await close.POST(post("/api/account/close", { confirm: true }));
    expect(await res.json()).toEqual({ closed: true });
    expect(services()).toEqual(["claim_deletion"]);
  });
});

describe("GET|POST /api/internal/deletions/retry", () => {
  const req = (auth?: string, method = "GET") => new Request(`${SITE}/api/internal/deletions/retry`, { method, headers: auth === undefined ? {} : { authorization: auth } });
  it("no CRON_SECRET configured → 503, nothing called, whatever the header", async () => {
    for (const h of [undefined, "Bearer ", "Bearer undefined", `Bearer ${SECRET}`]) {
      const res = await retry.GET(req(h));
      expect(res.status).toBe(503);
    }
    expect(calls).toEqual([]);
  });
  it("a CRON_SECRET shorter than 32 characters counts as not configured", async () => {
    process.env.CRON_SECRET = "short-secret";
    expect((await retry.GET(req("Bearer short-secret"))).status).toBe(503);
    expect(calls).toEqual([]);
  });
  it("wrong, missing or malformed authorization → 401, nothing called", async () => {
    process.env.CRON_SECRET = SECRET;
    // (a trailing space is not a different header: Fetch strips it before the route sees it)
    for (const h of [undefined, "", SECRET, `bearer ${SECRET}`, `Bearer  ${SECRET}`, `Bearer ${SECRET}x`, `Basic ${SECRET}`, `Bearer ${SECRET.slice(1)}`]) {
      expect((await retry.GET(req(h))).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });
  it("a signed-in person's cookie session is not enough (the route never reads it)", async () => {
    process.env.CRON_SECRET = SECRET;
    const r = new Request(`${SITE}/api/internal/deletions/retry`, { headers: { cookie: "sb-access-token=x", origin: SITE } });
    expect((await retry.GET(r)).status).toBe(401);
  });
  it("authorised: processes the due list from the database (not from the request), raises alerts, answers counts only", async () => {
    process.env.CRON_SECRET = SECRET;
    const due = [ME, OTHER];
    const state: Record<string, boolean> = {};
    serviceRpc = {
      deletions_due: () => ({ data: due }),
      claim_deletion: (a) => state[a.p_subject as string] ? { data: { claimed: false, reason: "done" } }
        : (state[a.p_subject as string] = true, { data: { claimed: true, token: "t", status: "closed", held_reason: null, banned: true, cancellations_done: false } }),
      deletions_needing_attention: () => ({ data: [{ subject_id: OTHER, reason: "held" }, { subject_id: ME, reason: "stuck" }] }),
    };
    const res = await retry.POST(new Request(`${SITE}/api/internal/deletions/retry?subject=${OTHER}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ subject: "ignored" }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ done: 2, held: 0, skipped: 0, failed: 0, lease_lost: 0, remaining: 0, alerts: 2, promoted: 0 });
    expect(calls.find((c) => c.fn === "record_deletion_worker_run")?.args).toEqual({ p_counts: body });   // the heartbeat
    expect(calls.findIndex((c) => c.fn === "promote_due_requests")).toBeLessThan(calls.findIndex((c) => c.fn === "deletions_due"));
    expect(JSON.stringify(body)).not.toContain(ME);
    expect(calls.filter((c) => c.client === "user")).toEqual([]);
    expect(calls.find((c) => c.fn === "deletions_due")?.args).toEqual({ p_limit: 20 });
    expect(reported).toEqual([["deletionNeedsAttention", "account", { code: "held" }], ["deletionNeedsAttention", "account", { code: "stuck" }]]);
    expect(calls.filter((c) => c.fn === "mark_deletion_alerted").map((c) => c.args)).toEqual([{ p_subject: OTHER }, { p_subject: ME }]);
    expect(services()).not.toContain("auth.ban");   // already banned: B is skipped
  });
  it("one record failing does not stop the others", async () => {
    process.env.CRON_SECRET = SECRET;
    serviceRpc = {
      deletions_due: () => ({ data: [ME, OTHER] }),
      claim_deletion: (a) => ({ data: { claimed: true, token: "t", status: "closed", held_reason: null, banned: true, cancellations_done: false, _s: a.p_subject } }),
      delete_account_data: (a) => a.p_subject === ME ? { error: { message: "staff_role" } } : {},
      deletions_needing_attention: () => ({ data: [] }),
    };
    const res = await retry.GET(req(`Bearer ${SECRET}`));
    // both records were attempted, and the run is reported as failed to the scheduler (review 24 Nov, PR #31)
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ done: 1, held: 0, skipped: 0, failed: 1, lease_lost: 0, remaining: 0, alerts: 0, promoted: 0, error: "run_incomplete", problems: ["records_failed"] });
    expect(JSON.stringify(body)).not.toContain(ME);
    // the retry logic is unchanged: the heartbeat is still recorded with the plain counts, and the failed record is
    // left for the next run (only the done one was deleted)
    expect(calls.find((c) => c.fn === "record_deletion_worker_run")?.args).toEqual({ p_counts: { done: 1, held: 0, skipped: 0, failed: 1, lease_lost: 0, remaining: 0, alerts: 0, promoted: 0 } });
    expect(calls.filter((c) => c.fn === "auth.delete").map((c) => c.args)).toEqual([{ id: OTHER }]);
  });
  it("a record whose processing throws counts as failed → 500, the next record still runs", async () => {
    process.env.CRON_SECRET = SECRET;
    let n = 0;
    serviceRpc = {
      deletions_due: () => ({ data: [ME, OTHER] }),
      claim_deletion: () => { if (n++ === 0) throw new TypeError("fetch failed"); return { data: { claimed: true, token: "t", status: "closed", held_reason: null, banned: true, cancellations_done: false } }; },
      deletions_needing_attention: () => ({ data: [] }),
    };
    const res = await retry.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ done: 1, failed: 1, problems: ["records_failed"] });
    expect(calls.map((c) => c.fn)).toContain("record_deletion_worker_run");
  });
  it("the heartbeat failing → 500 (problems: heartbeat), after the records were processed", async () => {
    process.env.CRON_SECRET = SECRET;
    serviceRpc.deletions_due = () => ({ data: [OTHER] });
    serviceRpc.record_deletion_worker_run = () => ({ error: { message: "x", code: "42501" } });
    const res = await retry.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ done: 1, held: 0, skipped: 0, failed: 0, lease_lost: 0, remaining: 0, alerts: 0, promoted: 0, error: "run_incomplete", problems: ["heartbeat"] });
    expect(calls.filter((c) => c.fn === "auth.delete").map((c) => c.args)).toEqual([{ id: OTHER }]);
    expect(reported).toEqual([["deletionStepFailed", "account", { code: "42501" }]]);
  });
  it("the attention check failing → 500 (problems: attention_check); the heartbeat is still recorded", async () => {
    process.env.CRON_SECRET = SECRET;
    serviceRpc.deletions_needing_attention = () => ({ error: { message: "x", code: "57014" } });
    const res = await retry.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ failed: 0, alerts: 0, error: "run_incomplete", problems: ["attention_check"] });
    expect(calls.map((c) => c.fn)).toContain("record_deletion_worker_run");
    expect(reported).toEqual([["deletionStepFailed", "account", { code: "57014" }]]);
  });
  it("an alert that cannot be marked → 500 (problems: alert_marking, once); the other alerts are still raised", async () => {
    process.env.CRON_SECRET = SECRET;
    const A = "d8600000-0000-4000-8000-00000000000a", B = "d8600000-0000-4000-8000-00000000000b";
    serviceRpc.deletions_needing_attention = () => ({ data: [{ subject_id: A, reason: "stuck" }, { subject_id: B, reason: "held" }, { subject_id: ME, reason: "stuck" }] });
    serviceRpc.mark_deletion_alerted = (a) => a.p_subject === ME ? {} : { error: { message: "x" } };
    const res = await retry.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ alerts: 1, problems: ["alert_marking"] });
    expect(reported.length).toBe(3);
    expect(JSON.stringify(body)).not.toMatch(/d8600000/);
  });
  it("held, skipped and lease-lost records and records left for the next run are not failures → 200", async () => {
    process.env.CRON_SECRET = SECRET;
    const LOST = "d8600000-0000-4000-8000-00000000000c";
    serviceRpc = {
      deletions_due: () => ({ data: [ME, OTHER, LOST] }),
      claim_deletion: (a) => a.p_subject === ME ? { data: { claimed: false, reason: "busy" } }
        : a.p_subject === OTHER ? { data: { claimed: true, token: "t", status: "held", held_reason: "admin_role", banned: true, cancellations_done: true } }
        : { data: { claimed: true, token: "t", status: "closed", held_reason: null, banned: true, cancellations_done: false } },
      // another run took LOST over: its first bookkeeping call says the lease is gone
      record_deletion_step: (a) => a.p_subject === LOST ? { error: { message: "lease_lost" } } : {},
      deletions_needing_attention: () => ({ data: [] }),
    };
    const res = await retry.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ done: 0, held: 1, skipped: 1, failed: 0, lease_lost: 1, remaining: 0, alerts: 0, promoted: 0 });
  });
  it("a failing run records no heartbeat (so the app's one-step closing pauses)", async () => {
    process.env.CRON_SECRET = SECRET;
    serviceRpc.deletions_due = () => ({ error: { message: "x", code: "57014" } });
    expect((await retry.GET(req(`Bearer ${SECRET}`))).status).toBe(500);
    expect(calls.map((c) => c.fn)).not.toContain("record_deletion_worker_run");
  });
  it("promotion failing → 500, nothing processed, no heartbeat", async () => {
    process.env.CRON_SECRET = SECRET;
    serviceRpc.promote_due_requests = () => ({ error: { message: "x", code: "57014" } });
    expect((await retry.GET(req(`Bearer ${SECRET}`))).status).toBe(500);
    expect(calls.map((c) => c.fn)).toEqual(["promote_due_requests"]);
  });
  it("records left over when the time budget runs out are not a failure → 200 (picked up next run)", async () => {
    process.env.CRON_SECRET = SECRET;
    serviceRpc.deletions_due = () => ({ data: [OTHER, ME] });
    let t = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => (t++ === 0 ? 0 : 45_000));   // past the 40 s budget after the start
    try {
      const res = await retry.GET(req(`Bearer ${SECRET}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ failed: 0, remaining: 2 });
    } finally { now.mockRestore(); }
  });
  it("the due list failing → 500, reported by code", async () => {
    process.env.CRON_SECRET = SECRET;
    serviceRpc.deletions_due = () => ({ error: { message: "x", code: "42501" } });
    expect((await retry.GET(req(`Bearer ${SECRET}`))).status).toBe(500);
    expect(reported).toEqual([["deletionStepFailed", "account", { code: "42501" }]]);
  });
});

describe("POST /api/admin/delete-account", () => {
  beforeEach(() => { userRpc.is_admin = { data: true }; });
  it("an admin's Retry runs the pipeline for that account with the service key", async () => {
    const res = await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: { result: "done" }, released: false });
    expect(calls[0]).toEqual({ client: "user", fn: "is_admin", args: undefined });
    expect(services()[0]).toBe("claim_deletion");
  });
  it("Release runs release_held_deletion with the ADMIN's session first, then the pipeline", async () => {
    await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "release" }));
    expect(calls.filter((c) => c.client === "user").map((c) => c.fn)).toEqual(["is_admin", "release_held_deletion"]);
    expect(calls.findIndex((c) => c.fn === "release_held_deletion")).toBeLessThan(calls.findIndex((c) => c.fn === "claim_deletion"));
  });
  it("Release refused by the database (still suspended): 409 with the code, nothing processed", async () => {
    userRpc.release_held_deletion = { error: { message: "suspended", code: "P0001" } };
    const res = await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "release" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "suspended", step: "release" });
    expect(services()).toEqual([]);
  });
  it("not an admin → 403, nothing processed", async () => {
    userRpc.is_admin = { data: false };
    expect((await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }))).status).toBe(403);
    expect(services()).toEqual([]);
  });
  it("is_admin erroring → 403 (fails closed)", async () => {
    userRpc.is_admin = { error: { message: "x" } };
    expect((await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }))).status).toBe(403);
    expect(services()).toEqual([]);
  });
  it("is_admin answering something truthy but not true → 403", async () => {
    userRpc.is_admin = { data: "true" };
    expect((await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }))).status).toBe(403);
  });
  it("an admin's own account → 403, before even asking is_admin", async () => {
    user = { id: OTHER };
    expect((await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }))).status).toBe(403);
    expect(calls).toEqual([]);
  });
  it("signed out → 401; cross-site → 403; bad subject or action → 400; nothing called", async () => {
    user = null;
    expect((await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }))).status).toBe(401);
    user = { id: ME };
    expect((await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }, { origin: "https://evil.example" }))).status).toBe(403);
    for (const b of [{ subject: "x", action: "retry" }, { subject: OTHER, action: "force" }, { subject: OTHER }, { subject: OTHER.toUpperCase(), action: "retry" }]) {
      expect((await adminRoute.POST(post("/api/admin/delete-account", b))).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  // carried over from the replaced three-step route's tests (src/app/api/admin/delete-account/route.test.ts, removed)
  it("the database refusing the data step stops before the sign-in is deleted, and says where", async () => {
    serviceRpc.delete_account_data = () => ({ error: { message: "legal_hold", code: "P0001" } });
    const res = await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }));
    expect(await res.json()).toEqual({ ok: false, outcome: { result: "failed", step: "data", code: "legal_hold" }, released: false });
    expect(services()).not.toContain("auth.delete");
    expect(services()).not.toContain("finish_account_deletion");
  });
  it("a failed sign-in deletion leaves the record to be resumed (no finish)", async () => {
    const real = (await import("@/lib/supabase/admin")).createAdminClient();
    real.auth.admin.deleteUser = async () => ({ error: { message: "Database error deleting user", status: 500 } }) as never;
    const del = vi.spyOn(await import("@/lib/supabase/admin"), "createAdminClient").mockReturnValue(real);
    const res = await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }));
    del.mockRestore();
    expect(await res.json()).toEqual({ ok: false, outcome: { result: "failed", step: "auth_delete", code: "failed" }, released: false });
    expect(services()).not.toContain("finish_account_deletion");
  });
  it("a refused finish is reported, not hidden", async () => {
    serviceRpc.finish_account_deletion = () => ({ error: { message: "account_still_exists", code: "P0001" } });
    const res = await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "retry" }));
    expect(await res.json()).toEqual({ ok: false, outcome: { result: "failed", step: "finish", code: "account_still_exists" }, released: false });
  });
  it("a network error in the pipeline is answered, not thrown; a committed release is reported as such", async () => {
    serviceRpc.claim_deletion = () => { throw new TypeError("fetch failed"); };
    const res = await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER, action: "release" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, outcome: { result: "failed", step: "claim", code: "exception" }, released: true });
  });
  it("the retry route raises at most 10 alerts per run", async () => {
    process.env.CRON_SECRET = SECRET;
    serviceRpc.deletions_due = () => ({ data: [] });
    serviceRpc.deletions_needing_attention = () => ({ data: Array.from({ length: 25 }, (_, i) => ({ subject_id: `d8600000-0000-4000-8000-${String(i).padStart(12, "0")}`, reason: "stuck" })) });
    const body = await (await retry.GET(new Request(`${SITE}/api/internal/deletions/retry`, { headers: { authorization: `Bearer ${SECRET}` } }))).json();
    expect(body.alerts).toBe(10);
    expect(reported.length).toBe(10);
  });
  it("the old body shape ({ subject } only, no action) is refused rather than guessed", async () => {
    expect((await adminRoute.POST(post("/api/admin/delete-account", { subject: OTHER }))).status).toBe(400);
  });
});
