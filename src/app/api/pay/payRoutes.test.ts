// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The payment routes (M12.1): /api/pay/start (fee attempts), /api/pay/callback/[provider], and the review fixes to
 * /api/pay/simulate. Supabase and the provider are mocks that record every call; the database rules themselves are
 * tested in SQL (supabase/tests/payments/fee_online_tests.sql).
 */
type Call = { client: "user" | "service"; fn: string; args?: unknown };
type Answer = { data?: unknown; error?: { message: string; code?: string } | null };
let calls: Call[];
let user: { id: string } | null;
let userRpc: Record<string, Answer | Answer[]>;
let serviceRpc: Record<string, (args: Record<string, unknown>) => Answer>;
let attemptRow: { id?: string; status: string; session_url: string | null; outcome?: string | null } | null;
let attemptReads: Array<typeof attemptRow>;     // successive reads of one attempt (each read takes the next; the last repeats)
let unresolvedRow: Record<string, unknown> | null;
let paymentLookup: Answer;
const reported: Array<[string, string, unknown]> = [];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async (fn: string, args?: unknown) => {
      calls.push({ client: "user", fn, args });
      const a = userRpc[fn];
      return { data: null, error: null, ...(Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : (a ?? {})) };
    },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => paymentLookup }) }) }) }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ client: "service", fn, args }); return { data: null, error: null, ...(serviceRpc[fn]?.(args) ?? {}) }; },
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) chain[m] = () => chain;
      chain.single = async () => ({ data: attemptReads.length > 1 ? attemptReads.shift() : (attemptReads[0] ?? attemptRow), error: null });
      chain.maybeSingle = async () => ({ data: unresolvedRow, error: null });
      return chain;
    },
  }),
}));
vi.mock("@/lib/report", () => ({ report: async (k: string, a: string, d: unknown) => { reported.push([k, a, d]); } }));

// the provider this deployment is configured for; swapped per test
const provider = {
  name: "whish" as "whish" | "simulated",
  startAttempt: vi.fn(),
  attemptStatus: vi.fn(),
  callbackAttemptId: vi.fn() as ((r: Request) => Promise<string | null>) | undefined,
  listCharges: vi.fn() as ((since: Date, until: Date) => Promise<never[]>) | undefined,   // charge-level reconciliation available
  start: vi.fn(), verify: vi.fn(), refund: vi.fn(),
};
vi.mock("@/lib/payments", () => ({
  getProvider: () => provider,
  providerNamed: (n: string) => (n === provider.name ? provider : null),
}));

const { PaymentStartRefused } = await import("@/lib/payments/provider");
const start = await import("./start/route");
const callback = await import("./callback/[provider]/route");
const simulate = await import("./simulate/route");

const ME = "0b000000-0000-4000-8000-000000000001";
const PAY = "0b000000-0000-4000-8000-0000000000aa";
const KEY = "0b000000-0000-4000-8000-0000000000bb";
const ATT = "0b000000-0000-4000-8000-0000000000cc";

const post = (path: string, body: unknown, host = "courtbook.example") =>
  new Request(`https://${host}${path}`, { method: "POST", headers: { "content-type": "application/json", host, "x-forwarded-host": host }, body: JSON.stringify(body) });
const attempt = (over: Partial<Record<string, unknown>> = {}) => ({ data: [{ attempt_id: ATT, attempt_no: 1, provider: "whish", amount_usd: "1.00", currency: "USD", status: "starting", session_url: null, already: false, ...over }] });
const serviceCalls = () => calls.filter((c) => c.client === "service").map((c) => c.fn);

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls = []; user = { id: ME }; userRpc = {}; serviceRpc = {}; attemptRow = null; attemptReads = []; unresolvedRow = null; reported.length = 0;
  paymentLookup = { data: null, error: null };
  provider.name = "whish";
  provider.startAttempt = vi.fn(async () => ({ kind: "redirect", url: "https://pay.whish.example/s/1", session: "S-1" }));
  provider.attemptStatus = vi.fn(async () => ({ state: "pending" }));
  provider.callbackAttemptId = vi.fn(async () => ATT);
  process.env.PAYMENT_SITE_URL = "https://courtbook.example";
  logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { delete process.env.PAYMENT_SITE_URL; logSpy.mockRestore(); });

describe("POST /api/pay/start", () => {
  it("refuses a malformed request before touching the database", async () => {
    for (const body of [{}, { paymentId: PAY }, { paymentId: "x", requestKey: KEY }, { paymentId: PAY, requestKey: "1; drop" }]) {
      expect((await start.POST(post("/api/pay/start", body))).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it("needs a signed-in player", async () => {
    user = null;
    expect((await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }))).status).toBe(401);
  });
  it("the attempt is made by the database as the player (their session), with the tap's request key", async () => {
    userRpc.start_payment_attempt = attempt();
    await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
    expect(calls[0]).toEqual({ client: "user", fn: "start_payment_attempt", args: { p_payment: PAY, p_request: KEY } });
  });
  it("provider URLs come from PAYMENT_SITE_URL, never from the request's host", async () => {
    userRpc.start_payment_attempt = attempt();
    const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }, "evil.example"));
    expect(await res.json()).toEqual({ redirect: "https://pay.whish.example/s/1" });
    const input = (provider.startAttempt as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input).toMatchObject({ attemptId: ATT, amountUsd: 1, currency: "USD",
      returnUrl: `https://courtbook.example/pay/return?attempt=${ATT}`, callbackUrl: "https://courtbook.example/api/pay/callback/whish" });
    expect(JSON.stringify(input)).not.toContain("evil");
    expect(calls.find((c) => c.fn === "open_payment_attempt")?.args).toEqual({ p_attempt: ATT, p_session_url: "https://pay.whish.example/s/1", p_provider_session: "S-1" });
  });
  it("a real provider without PAYMENT_SITE_URL is refused, and the attempt is closed", async () => {
    delete process.env.PAYMENT_SITE_URL;
    userRpc.start_payment_attempt = attempt();
    const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
    expect(res.status).toBe(503);
    expect(provider.startAttempt).not.toHaveBeenCalled();
    expect(serviceCalls()).toEqual(["abandon_payment_attempt"]);
  });
  it("review 25 Nov: a real provider without charge-level reconciliation (no charge list, no approved alternative) starts nothing: 503, the attempt closed, the provider never called", async () => {
    userRpc.start_payment_attempt = attempt();
    const list = provider.listCharges;
    provider.listCharges = undefined;                                   // a real provider with no charge list, no approval
    try {
      const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
      expect([res.status, (await res.json()).error]).toEqual([503, "payments_not_configured"]);
      expect(provider.startAttempt).not.toHaveBeenCalled();
      expect(serviceCalls()).toEqual(["abandon_payment_attempt"]);
    } finally { provider.listCharges = list; }
  });
  it("a provider that definitely refused: attempt closed, a final fixed code, nothing of the provider's text", async () => {
    userRpc.start_payment_attempt = attempt({ attempt_no: 2 });
    provider.startAttempt = vi.fn(async () => { throw new PaymentStartRefused("merchant secret abc"); });
    const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
    expect([res.status, await res.json()]).toEqual([502, { error: "gateway_error", final: true, attemptsLeft: 1 }]);
    expect(serviceCalls()).toEqual(["abandon_payment_attempt"]);
  });
  it("a provider TIMEOUT is not a failure: the attempt is left unresolved for the provider's status, the browser keeps its key", async () => {
    userRpc.start_payment_attempt = attempt();
    provider.startAttempt = vi.fn(async () => { throw new Error("The operation was aborted due to timeout"); });
    const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
    expect([res.status, await res.json()]).toEqual([502, { error: "payment_uncertain", final: false }]);
    expect(serviceCalls()).toEqual([]);                                 // not abandoned: still 'starting', still swept
    expect(reported).toEqual([["paymentProvider", "payment", { code: "start_unknown" }]]);
  });
  it("...the same tap retried later: the provider is ASKED (not called again); the session it had created was paid: confirmed", async () => {
    userRpc.start_payment_attempt = attempt({ already: true, status: "starting" });
    attemptReads = [{ id: ATT, status: "starting", session_url: null }, { id: ATT, status: "starting", session_url: null }, { id: ATT, status: "starting", session_url: null },
      { id: ATT, status: "starting", session_url: null }, { id: ATT, status: "starting", session_url: null }, { id: ATT, status: "starting", session_url: null },
      { id: ATT, status: "succeeded", session_url: null, outcome: "confirmed" }];
    provider.attemptStatus = vi.fn(async () => ({ state: "succeeded", evidence: { providerRef: "W-late", amount: 1, currency: "USD" } }));
    serviceRpc.record_attempt_result = () => ({ data: "confirmed" });
    const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
    expect(await res.json()).toEqual({ attempt: ATT, outcome: "confirmed" });
    expect(provider.startAttempt).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === "record_attempt_result")?.args).toEqual({ p_attempt: ATT, p_result: "succeeded", p_provider_ref: "W-late", p_amount: 1, p_currency: "USD" });
  }, 10_000);
  it("an http payment page is never handed to the player", async () => {
    userRpc.start_payment_attempt = attempt();
    provider.startAttempt = vi.fn(async () => ({ kind: "redirect", url: "http://pay.whish.example/s/1", session: "S" }));
    expect((await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }))).status).toBe(502);
    expect(serviceCalls()).toEqual(["abandon_payment_attempt"]);
  });
  it("the same tap again: the stored payment page, and the provider is NOT asked a second time", async () => {
    userRpc.start_payment_attempt = attempt({ status: "open", session_url: "https://pay.whish.example/s/1", already: true });
    expect(await (await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }))).json()).toEqual({ redirect: "https://pay.whish.example/s/1" });
    expect(provider.startAttempt).not.toHaveBeenCalled();
  });
  it("database refusals come back by name with their status; anything else as a fixed code, reported without text", async () => {
    for (const [code, status] of [["hold_expired", 409], ["attempts_exhausted", 409], ["not_found", 404], ["not_payable", 409], ["account_closed", 403]] as const) {
      userRpc.start_payment_attempt = { error: { message: code } };
      const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
      expect([res.status, await res.json()]).toEqual([status, { error: code, final: true }]);
    }
    userRpc.start_payment_attempt = { error: { message: 'relation "payment_attempts" violates … Key (id)=(secret)', code: "23505" } };
    const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
    expect([res.status, await res.json()]).toEqual([500, { error: "payment_start_failed", final: false }]);
    expect(reported).toEqual([["paymentStart", "payment", { code: "23505" }]]);
  });
  it("simulated (demo clubs): the immediate result is recorded through the same database function", async () => {
    provider.name = "simulated";
    provider.startAttempt = vi.fn(async () => ({ kind: "immediate", evidence: { providerRef: `SIM-${ATT}`, amount: 1, currency: "USD" } }));
    userRpc.start_payment_attempt = attempt({ provider: "simulated" });
    serviceRpc.record_attempt_result = () => ({ data: "confirmed" });
    const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
    expect(await res.json()).toEqual({ attempt: ATT, outcome: "confirmed" });
    expect(calls.find((c) => c.fn === "record_attempt_result")?.args).toEqual({ p_attempt: ATT, p_result: "succeeded", p_provider_ref: `SIM-${ATT}`, p_amount: 1, p_currency: "USD" });
  });
  it("only the simulated provider may succeed immediately; a real one claiming it is neither trusted nor dropped (left to its status)", async () => {
    provider.startAttempt = vi.fn(async () => ({ kind: "immediate", evidence: { providerRef: "X", amount: 1, currency: "USD" } }));
    userRpc.start_payment_attempt = attempt();
    const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
    expect([res.status, await res.json()]).toEqual([502, { error: "payment_uncertain", final: false }]);
    expect(serviceCalls()).toEqual([]);
  });

  describe("another attempt is unresolved (review of PR #34, blocker 2)", () => {
    const inProgress = { error: { message: "attempt_in_progress" } };
    const OPEN = "0b000000-0000-4000-8000-0000000000dd";
    it("still open at the provider: the player is sent back to THAT payment page; no new attempt", async () => {
      userRpc.start_payment_attempt = [inProgress];
      unresolvedRow = { id: OPEN, status: "open", session_url: "https://pay.whish.example/s/0", outcome: null, provider: "whish" };
      attemptReads = [{ id: OPEN, status: "open", session_url: "https://pay.whish.example/s/0" }];
      const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
      expect(await res.json()).toEqual({ redirect: "https://pay.whish.example/s/0" });
      expect(provider.attemptStatus).toHaveBeenCalledWith(OPEN);
      expect(provider.startAttempt).not.toHaveBeenCalled();
      expect(calls.filter((c) => c.fn === "start_payment_attempt")).toHaveLength(1);
    });
    it("open but with no usable payment page: 'in progress', not final, no new attempt", async () => {
      userRpc.start_payment_attempt = [inProgress];
      unresolvedRow = { id: OPEN, status: "open", session_url: null, outcome: null, provider: "whish" };
      attemptReads = [{ id: OPEN, status: "open", session_url: null }];
      const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
      expect([res.status, await res.json()]).toEqual([409, { error: "payment_in_progress", final: false }]);
      expect(provider.startAttempt).not.toHaveBeenCalled();
    });
    it("still starting and the provider cannot say: 'in progress', not final, no new attempt", async () => {
      userRpc.start_payment_attempt = [inProgress];
      unresolvedRow = { id: OPEN, status: "starting", session_url: null, outcome: null, provider: "whish" };
      attemptReads = [{ id: OPEN, status: "starting", session_url: null }];
      provider.attemptStatus = vi.fn(async () => { throw new Error("timeout"); });
      const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
      expect([res.status, await res.json()]).toEqual([409, { error: "payment_in_progress", final: false }]);
      expect(provider.startAttempt).not.toHaveBeenCalled();
    });
    it("the provider says it expired: recorded, and only then the next attempt is started", async () => {
      userRpc.start_payment_attempt = [inProgress, attempt({ attempt_no: 2 })];
      unresolvedRow = { id: OPEN, status: "open", session_url: "https://pay.whish.example/s/0", outcome: null, provider: "whish" };
      attemptReads = [{ id: OPEN, status: "expired", session_url: "https://pay.whish.example/s/0" }];
      provider.attemptStatus = vi.fn(async () => ({ state: "expired" }));
      const res = await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }));
      expect(await res.json()).toEqual({ redirect: "https://pay.whish.example/s/1" });
      expect(calls.map((c) => c.fn)).toEqual(["start_payment_attempt", "record_attempt_result", "start_payment_attempt", "open_payment_attempt"]);
      expect(calls.find((c) => c.fn === "record_attempt_result")?.args).toEqual({ p_attempt: OPEN, p_result: "expired" });
    });
    it("the provider says it was paid: the outcome is shown, no new attempt", async () => {
      userRpc.start_payment_attempt = [inProgress];
      unresolvedRow = { id: OPEN, status: "open", session_url: "https://pay.whish.example/s/0", outcome: null, provider: "whish" };
      attemptReads = [{ id: OPEN, status: "succeeded", session_url: null, outcome: "confirmed" }];
      provider.attemptStatus = vi.fn(async () => ({ state: "succeeded", evidence: { providerRef: "W-0", amount: 1, currency: "USD" } }));
      serviceRpc.record_attempt_result = () => ({ data: "confirmed" });
      expect(await (await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }))).json()).toEqual({ attempt: OPEN, outcome: "confirmed" });
      expect(provider.startAttempt).not.toHaveBeenCalled();
    });
  });
  it("an attempt written for another provider than this deployment's is closed, not guessed at", async () => {
    userRpc.start_payment_attempt = attempt({ provider: "areeba" });
    expect((await start.POST(post("/api/pay/start", { paymentId: PAY, requestKey: KEY }))).status).toBe(503);
    expect(provider.startAttempt).not.toHaveBeenCalled();
  });
});

describe("POST /api/pay/callback/[provider]", () => {
  const cb = (name: string) => callback.POST(post(`/api/pay/callback/${name}`, { status: "success", amount: 1 }), { params: Promise.resolve({ provider: name }) });
  it("the callback's own claims are ignored: the server asks the provider and records ITS answer", async () => {
    provider.attemptStatus = vi.fn(async () => ({ state: "failed" }));
    serviceRpc.record_attempt_result = () => ({ data: "failed" });
    const res = await cb("whish");
    expect(res.status).toBe(200);
    expect(provider.attemptStatus).toHaveBeenCalledWith(ATT);
    expect(calls.find((c) => c.fn === "record_attempt_result")?.args).toEqual({ p_attempt: ATT, p_result: "failed" });
  });
  it("another provider's name, or a provider without callbacks: 404, nothing recorded", async () => {
    expect((await cb("areeba")).status).toBe(404);
    provider.callbackAttemptId = undefined;
    expect((await cb("whish")).status).toBe(404);
    expect(calls).toEqual([]);
  });
  it("a callback naming no valid attempt: 400, the provider is not asked", async () => {
    provider.callbackAttemptId = vi.fn(async () => "not-an-id");
    expect((await cb("whish")).status).toBe(400);
    expect(provider.attemptStatus).not.toHaveBeenCalled();
  });
  it("an attempt that is not ours: answered 200 with nothing said", async () => {
    serviceRpc.record_attempt_result = () => ({ error: { message: "attempt_not_found" } });
    const res = await cb("whish");
    expect([res.status, await res.json()]).toEqual([200, { ok: true }]);
  });
  it("provider unreachable: 503 so a retrying provider tries again; the sweeper will ask later anyway", async () => {
    provider.attemptStatus = vi.fn(async () => { throw new Error("down"); });
    expect((await cb("whish")).status).toBe(503);
    expect(reported).toEqual([["paymentProvider", "payment", { code: "provider_unavailable" }]]);
  });
});

describe("POST /api/pay/simulate (Model 1) review fixes", () => {
  it("a failed lookup returns no database text and logs no identifiers", async () => {
    paymentLookup = { data: null, error: { message: 'permission denied for table payments (user 0b00…)', code: "42501" } };
    const res = await simulate.POST(post("/api/pay/simulate", { paymentId: PAY }));
    expect([res.status, await res.json()]).toEqual([404, { error: "not_found" }]);
    expect(logSpy).not.toHaveBeenCalled();
    expect(reported).toEqual([["paymentLookup", "payment", { code: "42501" }]]);
  });
  it("refuses a malformed id", async () => {
    expect((await simulate.POST(post("/api/pay/simulate", { paymentId: "1 or 1=1" }))).status).toBe(400);
  });
  it("a fee-only payment is never paid through the Model 1 route", async () => {
    paymentLookup = { data: { id: PAY, total_usd: 1, status: "pending", provider: "simulated", kind: "fee_only", session_ref: null, session_url: null, bookings: { status: "pending" } }, error: null };
    const res = await simulate.POST(post("/api/pay/simulate", { paymentId: PAY }));
    expect([res.status, await res.json()]).toEqual([409, { error: "use_payment_attempts" }]);
  });
  it("a refused confirmation answers with a known code only", async () => {
    provider.name = "simulated";
    provider.start = vi.fn(async () => ({ kind: "immediate", providerRef: "SIM-1" }));
    paymentLookup = { data: { id: PAY, total_usd: 26, status: "pending", provider: "simulated", kind: "court_and_fee", session_ref: null, session_url: null, bookings: { status: "pending" } }, error: null };
    serviceRpc.confirm_payment = () => ({ error: { message: "new row for relation \"payments\" violates check constraint …", code: "23514" } });
    const res = await simulate.POST(post("/api/pay/simulate", { paymentId: PAY }));
    expect([res.status, await res.json()]).toEqual([409, { error: "payment_failed" }]);
  });
  it("not payable: the reason is not echoed with the booking's state", async () => {
    paymentLookup = { data: { id: PAY, total_usd: 26, status: "paid", provider: "simulated", kind: "court_and_fee", session_ref: null, session_url: null, bookings: { status: "confirmed" } }, error: null };
    expect(await (await simulate.POST(post("/api/pay/simulate", { paymentId: PAY }))).json()).toEqual({ error: "not_payable" });
  });
});
