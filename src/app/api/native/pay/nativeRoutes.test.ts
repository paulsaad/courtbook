// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The app's payment endpoints (M12.4): /api/native/pay/start and /api/native/pay/status. Who the player is comes only
 * from `Authorization: Bearer <access token>`, checked with Supabase Auth; the payment rules are the website's
 * (startFlow.ts, covered in depth by src/app/api/pay/payRoutes.test.ts). Supabase and the provider are mocks that
 * record every call. That one player cannot start, inspect or confirm another's payment against a real database is
 * shown in supabase/tests/api/native.mjs.
 */
type Answer = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };
const ME = "0b000000-0000-4000-8000-000000000001";
const OTHER = "0b000000-0000-4000-8000-000000000002";
const PAY = "0b000000-0000-4000-8000-0000000000aa";
const KEY = "0b000000-0000-4000-8000-0000000000bb";
const ATT = "0b000000-0000-4000-8000-0000000000cc";
const GOOD = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZSJ9.c2lnbmF0dXJl";
const EXPIRED = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.c2lnbmF0dXJl";

let calls: Array<{ client: "player" | "service"; what: string; args?: unknown }>;
let userRpc: Record<string, Answer>;
let clientsMade: Array<{ url: string; key: string; opts: { global?: { headers?: Record<string, string> } } }>;
let getUserTokens: string[];
let paymentRow: Record<string, unknown> | null;     // what the payments table holds for PAY
let attemptRows: Array<Record<string, unknown>>;
let refundCount: number;
let failRead: { payments?: boolean; attempts?: boolean | "second"; charges?: boolean | "null-count" };
let attemptReadsDone: number;
const reported: Array<[string, string, unknown]> = [];

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, opts: { global?: { headers?: Record<string, string> } }) => {
    clientsMade.push({ url, key, opts });
    return {
      auth: {
        getUser: async (jwt: string) => {
          getUserTokens.push(jwt);
          if (jwt === GOOD) return { data: { user: { id: ME } }, error: null };
          return { data: { user: null }, error: { message: "invalid JWT: token is expired" } };
        },
      },
      rpc: async (fn: string, args?: unknown) => { calls.push({ client: "player", what: fn, args }); return { data: null, error: null, ...(userRpc[fn] ?? {}) }; },
      from: (table: string) => {
        const filters: Record<string, unknown> = {};
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "order", "in", "limit"]) chain[m] = () => chain;
        chain.eq = (col: string, v: unknown) => { filters[col] = v; return chain; };
        chain.maybeSingle = async () => {
          calls.push({ client: "player", what: `read ${table}`, args: { ...filters } });
          // the real table: the row exists for its owner only when the route asks for profile_id = owner
          if (table === "payments" && failRead.payments) return { data: null, error: { message: "timeout", code: "57014" } };
          const row = table === "payments" && paymentRow && filters.id === PAY && filters.profile_id === paymentRow.profile_id ? paymentRow : null;
          return { data: row, error: null };
        };
        chain.then = (res: (a: Answer) => unknown) => {
          calls.push({ client: "player", what: `read ${table}`, args: { ...filters } });
          if (table === "payment_attempts") {
            attemptReadsDone++;
            const fails = failRead.attempts === true || (failRead.attempts === "second" && attemptReadsDone >= 2);
            if (fails) return Promise.resolve({ data: null, error: { message: "connection reset", code: "08006" } }).then(res);
          }
          return Promise.resolve({ data: table === "payment_attempts" ? attemptRows : [], error: null }).then(res);
        };
        return chain;
      },
    };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ client: "service", what: fn, args }); return { data: "succeeded", error: null }; },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) chain[m] = () => chain;
      chain.single = async () => ({ data: { id: ATT, status: "open", session_url: "https://pay.whish.example/s/1", outcome: null }, error: null });
      chain.maybeSingle = async () => ({ data: null, error: null });
      chain.then = (res: (a: Answer) => unknown) => {
        calls.push({ client: "service", what: `count ${table}` });
        if (failRead.charges === true) return Promise.resolve({ data: null, error: { message: "timeout", code: "57014" }, count: null }).then(res);
        if (failRead.charges === "null-count") return Promise.resolve({ data: null, error: null, count: null }).then(res);
        return Promise.resolve({ data: null, error: null, count: refundCount }).then(res);
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/report", () => ({ report: async (k: string, a: string, d: unknown) => { reported.push([k, a, d]); } }));

const provider = {
  name: "whish" as "whish" | "simulated",
  startAttempt: vi.fn(),
  attemptStatus: vi.fn(),
  callbackAttemptId: vi.fn(),
  listCharges: vi.fn() as ((since: Date, until: Date) => Promise<never[]>) | undefined,   // charge-level reconciliation available
  start: vi.fn(), verify: vi.fn(), refund: vi.fn(),
};
vi.mock("@/lib/payments", () => ({ getProvider: () => provider, providerNamed: (n: string) => (n === provider.name ? provider : null) }));

const start = await import("./start/route");
const status = await import("./status/route");
const { bearerToken } = await import("@/lib/supabase/bearer");

const req = (path: string, body: unknown, auth?: string) =>
  new Request(`https://courtbook.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth !== undefined ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const attempt = (over: Partial<Record<string, unknown>> = {}) => ({ data: [{ attempt_id: ATT, attempt_no: 1, provider: "whish", amount_usd: "1.00", currency: "USD", status: "starting", session_url: null, already: false, ...over }] });
const future = () => new Date(Date.now() + 8 * 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();
const pay = (over: Record<string, unknown> = {}, booking: Record<string, unknown> = {}) =>
  ({ id: PAY, kind: "fee_only", status: "pending", booking_id: "bk", profile_id: ME, bookings: { status: "pending", hold_expires_at: future(), ...booking }, ...over });

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls = []; userRpc = {}; clientsMade = []; getUserTokens = []; paymentRow = null; attemptRows = []; refundCount = 0; reported.length = 0;
  failRead = {}; attemptReadsDone = 0;
  provider.name = "whish";
  provider.startAttempt = vi.fn(async () => ({ kind: "redirect", url: "https://pay.whish.example/s/1", session: "S-1" }));
  provider.attemptStatus = vi.fn(async () => ({ state: "pending" }));
  process.env.PAYMENT_SITE_URL = "https://courtbook.example";
  process.env.NATIVE_PAYMENTS = "1";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { delete process.env.PAYMENT_SITE_URL; delete process.env.NATIVE_PAYMENTS; logSpy.mockRestore(); });

describe("bearer token parsing", () => {
  it("accepts exactly `Bearer <jwt>` and nothing else", () => {
    expect(bearerToken(`Bearer ${GOOD}`)).toBe(GOOD);
    for (const h of [null, "", GOOD, `bearer ${GOOD}`, `Bearer  ${GOOD}`, `Bearer ${GOOD} x`, "Bearer abc", "Bearer a.b", `Basic ${GOOD}`, `Bearer ${GOOD}\n`, `Bearer ${"a".repeat(9000)}.b.c`])
      expect(bearerToken(h)).toBeNull();
  });
});

describe("POST /api/native/pay/start", () => {
  it("is off unless NATIVE_PAYMENTS=1 on this deployment (final: the app stops)", async () => {
    for (const v of [undefined, "", "true", "yes", " 1", "0"]) {
      if (v === undefined) delete process.env.NATIVE_PAYMENTS; else process.env.NATIVE_PAYMENTS = v;
      const r = await start.POST(req("/api/native/pay/start", { paymentId: PAY, requestKey: KEY }, `Bearer ${GOOD}`));
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ error: "payments_not_configured", final: true });
    }
    expect(getUserTokens).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses a malformed request before asking Auth or the database", async () => {
    for (const body of ["not json", "null", {}, { paymentId: PAY }, { paymentId: "x", requestKey: KEY }, { paymentId: PAY, requestKey: "1; drop" }, [PAY, KEY]]) {
      const r = await start.POST(req("/api/native/pay/start", body, `Bearer ${GOOD}`));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_request", final: true });
    }
    expect(getUserTokens).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("refuses without a token, with a malformed header, or with a token Auth rejects (expired) — nothing reaches the database", async () => {
    for (const h of [undefined, "", "Bearer", `Basic ${GOOD}`, "Bearer not-a-jwt", `Bearer ${EXPIRED}`]) {
      const r = await start.POST(req("/api/native/pay/start", { paymentId: PAY, requestKey: KEY }, h));
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: "not_authenticated", final: true });
    }
    expect(getUserTokens).toEqual([EXPIRED]);             // only a well-formed token is put to Auth
    expect(calls).toEqual([]);
    expect(provider.startAttempt).not.toHaveBeenCalled();
  });

  it("acts as the player: the token goes to Auth and in the player client's header — never the service key", async () => {
    userRpc.start_payment_attempt = attempt();
    const r = await start.POST(req("/api/native/pay/start", { paymentId: PAY, requestKey: KEY }, `Bearer ${GOOD}`));
    expect(r.status).toBe(200);
    expect(getUserTokens).toEqual([GOOD]);
    expect(clientsMade).toHaveLength(1);
    expect(clientsMade[0].key).toBe("anon-key");
    expect(clientsMade[0].opts.global?.headers?.Authorization).toBe(`Bearer ${GOOD}`);
    expect(calls[0]).toEqual({ client: "player", what: "start_payment_attempt", args: { p_payment: PAY, p_request: KEY } });
  });

  it("gives the provider the app return page — carrying no token, no attempt, no payment — and the configured callback", async () => {
    userRpc.start_payment_attempt = attempt();
    const r = await start.POST(req("/api/native/pay/start", { paymentId: PAY, requestKey: KEY }, `Bearer ${GOOD}`));
    expect(await r.json()).toEqual({ redirect: "https://pay.whish.example/s/1" });
    const input = provider.startAttempt.mock.calls[0][0];
    expect(input.returnUrl).toBe("https://courtbook.example/pay/app-return");
    expect(input.callbackUrl).toBe("https://courtbook.example/api/pay/callback/whish");
    expect(JSON.stringify(input)).not.toContain(GOOD);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("review 25 Nov (#40): in the app too, a real provider without charge-level reconciliation starts nothing — 503 payments_not_configured, the provider never called", async () => {
    userRpc.start_payment_attempt = attempt();
    const list = provider.listCharges;
    provider.listCharges = undefined;
    try {
      const r = await start.POST(req("/api/native/pay/start", { paymentId: PAY, requestKey: KEY }, `Bearer ${GOOD}`));
      expect([r.status, (await r.json()).error]).toEqual([503, "payments_not_configured"]);
      expect(provider.startAttempt).not.toHaveBeenCalled();
    } finally { provider.listCharges = list; }
  });

  it("another player's payment: the database refuses it as not found, and so does the route (nothing reaches the provider)", async () => {
    userRpc.start_payment_attempt = { error: { message: "not_found", code: "P0001" } };
    const r = await start.POST(req("/api/native/pay/start", { paymentId: PAY, requestKey: KEY }, `Bearer ${GOOD}`));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found", final: true });
    expect(provider.startAttempt).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.client === "service")).toEqual([]);
  });

  it("expired hold, unsupported mode, used-up attempts: the database's refusals come back as final codes", async () => {
    for (const [msg, code, http] of [["hold_expired", "hold_expired", 409], ["wrong_payment_mode", "wrong_payment_mode", 409], ["attempts_exhausted", "attempts_exhausted", 409], ["not_payable", "not_payable", 409]] as const) {
      userRpc.start_payment_attempt = { error: { message: msg, code: "P0001" } };
      const r = await start.POST(req("/api/native/pay/start", { paymentId: PAY, requestKey: KEY }, `Bearer ${GOOD}`));
      expect(r.status).toBe(http);
      expect(await r.json()).toEqual({ error: code, final: true });
    }
    expect(provider.startAttempt).not.toHaveBeenCalled();
  });

  it("a provider timeout is an unknown outcome: not final, the app keeps its key, nothing about the token is reported", async () => {
    userRpc.start_payment_attempt = attempt();
    provider.startAttempt = vi.fn(async () => { throw new Error(`socket hang up ${GOOD}`); });
    const r = await start.POST(req("/api/native/pay/start", { paymentId: PAY, requestKey: KEY }, `Bearer ${GOOD}`));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "payment_uncertain", final: false });
    expect(JSON.stringify(reported)).not.toContain(GOOD);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(GOOD));
  });
});

describe("POST /api/native/pay/status", () => {
  const ask = (auth = `Bearer ${GOOD}`, body: unknown = { paymentId: PAY }) => status.POST(req("/api/native/pay/status", body, auth));

  it("is off unless NATIVE_PAYMENTS=1, refuses malformed input and bad tokens before the database", async () => {
    delete process.env.NATIVE_PAYMENTS;
    expect((await ask()).status).toBe(503);
    process.env.NATIVE_PAYMENTS = "1";
    for (const b of [{}, { paymentId: "x" }, "nope"]) expect((await ask(`Bearer ${GOOD}`, b)).status).toBe(400);
    for (const h of ["", "Bearer x", `Bearer ${EXPIRED}`]) expect((await ask(h)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("reads only the player's own payment (profile_id = the token's user): someone else's is not found and nothing is asked of the provider", async () => {
    paymentRow = pay({ profile_id: OTHER });
    const r = await ask();
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found", final: true });
    expect(calls).toEqual([{ client: "player", what: "read payments", args: { id: PAY, profile_id: ME } }]);
    expect(provider.attemptStatus).not.toHaveBeenCalled();
  });

  it("a court-and-fee (simulated, whole price) payment is not this endpoint's", async () => {
    paymentRow = pay({ kind: "court_and_fee" });
    expect((await ask()).status).toBe(409);
  });

  it("live hold, nothing tried yet: awaiting_payment with three tries", async () => {
    paymentRow = pay();
    const b = await (await ask()).json();
    expect(b).toMatchObject({ state: "awaiting_payment", bookingStatus: "pending", attempt: null, attemptsLeft: 3, refundsDue: 0 });
  });

  it("an unresolved attempt is settled by asking the provider first; still pending → payment_open", async () => {
    paymentRow = pay();
    attemptRows = [{ id: ATT, status: "open", outcome: null, attempt_no: 1, provider: "whish" }];
    const b = await (await ask()).json();
    expect(provider.attemptStatus).toHaveBeenCalledWith(ATT);
    expect(b).toMatchObject({ state: "payment_open", attemptsLeft: 2, attempt: { status: "open", attemptNo: 1 } });
  });

  it("a 'starting' attempt the provider cannot answer for → checking (never paid, never retried)", async () => {
    paymentRow = pay();
    attemptRows = [{ id: ATT, status: "starting", outcome: null, attempt_no: 1, provider: "whish" }];
    provider.attemptStatus = vi.fn(async () => { throw new Error("timeout"); });
    const b = await (await ask()).json();
    expect(b.state).toBe("checking");
    expect(reported).toContainEqual(["paymentProvider", "payment", { code: "provider_unavailable" }]);
    expect(calls.some((c) => c.what === "start_payment_attempt")).toBe(false);
  });

  it("confirmed booking → confirmed; expired hold → hold_expired; money with no booking → refund_due; cancelled → cancelled", async () => {
    paymentRow = pay({ status: "paid" }, { status: "confirmed", hold_expires_at: null });
    expect((await (await ask()).json()).state).toBe("confirmed");
    paymentRow = pay({}, { status: "pending", hold_expires_at: past() });
    expect((await (await ask()).json()).state).toBe("hold_expired");
    paymentRow = pay({}, { status: "expired", hold_expires_at: past() });
    expect((await (await ask()).json()).state).toBe("hold_expired");
    refundCount = 1;
    paymentRow = pay({}, { status: "expired", hold_expires_at: past() });
    expect(await (await ask()).json()).toMatchObject({ state: "refund_due", refundsDue: 1 });
    refundCount = 0;
    paymentRow = pay({ status: "failed" }, { status: "cancelled", hold_expires_at: null });
    expect((await (await ask()).json()).state).toBe("cancelled");
  });

  describe("fails closed when a financial read fails (review of PR #37)", () => {
    const UNAVAILABLE = { error: "payment_status_unavailable", final: false };
    const noClaims = (b: Record<string, unknown>) => {
      for (const k of ["state", "attemptsLeft", "refundsDue", "attempt", "paymentStatus", "bookingStatus"]) expect(b).not.toHaveProperty(k);
    };

    it("the attempts cannot be read: a temporary error — not 'three tries left', not 'awaiting payment'", async () => {
      paymentRow = pay();
      failRead.attempts = true;
      const r = await ask();
      const b = await r.json();
      expect(r.status).toBe(503);
      expect(b).toEqual(UNAVAILABLE);
      noClaims(b);
      expect(provider.attemptStatus).not.toHaveBeenCalled();
      expect(reported).toContainEqual(["paymentLookup", "payment", { code: "08006" }]);
    });

    it("the attempts cannot be re-read after asking the provider: still a temporary error, never a guessed state", async () => {
      paymentRow = pay();
      attemptRows = [{ id: ATT, status: "open", outcome: null, attempt_no: 1, provider: "whish" }];
      failRead.attempts = "second";
      const r = await ask();
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual(UNAVAILABLE);
      expect(provider.attemptStatus).toHaveBeenCalledWith(ATT);      // the provider's answer is still recorded
    });

    it("the refunds owed cannot be read: a temporary error — not 'nothing owed', even with money arrived and no booking", async () => {
      for (const mode of [true, "null-count"] as const) {
        failRead.charges = mode;
        paymentRow = pay({ status: "refund_due" }, { status: "expired", hold_expires_at: past() });
        const r = await ask();
        const b = await r.json();
        expect(r.status).toBe(503);
        expect(b).toEqual(UNAVAILABLE);
        noClaims(b);
      }
    });

    it("the payment itself cannot be read: the same temporary error (not 404, not 500)", async () => {
      paymentRow = pay();
      failRead.payments = true;
      const r = await ask();
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual(UNAVAILABLE);
    });
  });

  it("never starts, retries or records anything itself apart from the provider's answer", async () => {
    paymentRow = pay();
    attemptRows = [{ id: ATT, status: "open", outcome: null, attempt_no: 1, provider: "whish" }];
    provider.attemptStatus = vi.fn(async () => ({ state: "pending" }));
    await ask();
    expect(provider.startAttempt).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.client === "player" && !c.what.startsWith("read"))).toEqual([]);
    expect(calls.filter((c) => c.client === "service" && !c.what.startsWith("count")).map((c) => c.what)).toEqual(["record_attempt_result"]);
  });
});
