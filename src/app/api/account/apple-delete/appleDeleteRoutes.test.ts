// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";

/**
 * E1 routes (draft, off by default): POST /api/account/apple-delete/intent and POST /api/account/apple-delete.
 * Supabase (the person's client and the service client) is mocked and records every call; Apple is a stubbed fetch —
 * no real Apple request is ever made. Covers: off unless configured; bearer required; the intent binds the original
 * account (two accounts); the full Apple path in order (revoke BEFORE processing); a lost close answer resolved from
 * the deletion record; an unknown result answered as unknown; the database's refusals.
 */
vi.mock("server-only", () => ({}));
const calls: string[] = [];
let bearerUser: string | null;
let identities: Record<string, unknown>[];
let closeAnswer: { error: { message: string; code?: string } | null; status?: number } | "throw";
let markFails: "error" | "unconfirmed" | null;
let keysStatus: number;
let tokenStatus: number;
let statusRows: { data: unknown; error: unknown };
let recent: boolean;
const metadata: Record<string, unknown>[] = [];
const reported: string[] = [];

const builder = <T,>(name: string, result: () => T) => ({
  abortSignal: (s: AbortSignal) => { void s; calls.push(name); return Promise.resolve().then(result); },
});
vi.mock("@/lib/supabase/bearer", () => ({
  playerFromBearer: async () => bearerUser ? { userId: bearerUser, player: {
    rpc: (fn: string) => builder(`user:${fn}`, () => {
      if (fn === "recently_authenticated") return { data: recent, error: null };
      if (fn === "close_my_account") { if (closeAnswer === "throw") throw new TypeError("fetch failed"); return { data: closeAnswer.error ? null : { status: "closing" }, status: closeAnswer.error ? 400 : 200, ...closeAnswer }; }
      return { data: null, error: { message: "unexpected", code: "X" } };
    }),
  } } : null,
}));
let claimed = false;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: {
      getUserById: async () => { calls.push("service:getUser"); return { data: { user: { id: bearerUser, identities, app_metadata: {} } }, error: null }; },
      updateUserById: async (_id: string, attrs: { app_metadata?: Record<string, unknown> }) => {
        if (attrs.app_metadata) {
          calls.push("service:mark"); metadata.push(attrs.app_metadata);
          if (markFails === "error") return { data: { user: null }, error: { message: "Database error updating user", status: 500 } };
          if (markFails === "unconfirmed") return { data: { user: { app_metadata: {} } }, error: null };
          return { data: { user: { app_metadata: attrs.app_metadata } }, error: null };
        }
        calls.push("service:ban");
        return { error: null };
      },
      deleteUser: async () => { calls.push("service:deleteUser"); return { error: null }; },
    } },
    from: () => ({ select: () => ({ eq: () => builder("service:status", () => statusRows) }) }),
    rpc: async (fn: string) => {
      calls.push(`service:${fn}`);
      if (fn === "claim_deletion") return claimed ? { data: { claimed: false, reason: "done" }, error: null }
        : (claimed = true, { data: { claimed: true, token: "t", status: "closing", held_reason: null, banned: false, cancellations_done: false }, error: null });
      return { data: null, error: null };
    },
  }),
}));
vi.mock("@/lib/report", () => ({ report: async (k: string) => { reported.push(k); } }));

// a fake Apple: its id_token signing key, and our app's client-secret key
const appleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...appleKey.publicKey.export({ format: "jwk" }), kid: "AK1", alg: "RS256" };
const ourKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(sub: string) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid: "AK1" });
  const body = b64({ iss: "https://appleid.apple.com", aud: "app.courtbook.mobile", sub, iat: now, exp: now + 600 });
  const s = createSign("RSA-SHA256"); s.update(`${head}.${body}`);
  return `${head}.${body}.${s.sign(appleKey.privateKey).toString("base64url")}`;
}
let appleSubForCode: Record<string, string>;
let revokeStatus: number;
const appleFetch = vi.fn(async (url: string, init?: { body?: string }) => {
  const path = new URL(url).pathname;
  calls.push(`apple:${path}`);
  const json = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => { if (body === undefined) throw new Error("empty"); return body; } });
  if (path === "/auth/keys") return keysStatus === 200 ? json(200, { keys: [JWK] }) : json(keysStatus);
  if (path === "/auth/token") {
    if (tokenStatus !== 200) return json(tokenStatus);
    const code = new URLSearchParams(init?.body ?? "").get("code") ?? "";
    const sub = appleSubForCode[code];
    return sub ? json(200, { id_token: idToken(sub), refresh_token: "RT", access_token: "AT" }) : json(400, { error: "invalid_grant" });
  }
  if (path === "/auth/revoke") return json(revokeStatus);
  return json(404, {});
});

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ENV = {
  APPLE_TEAM_ID: "ABCDE12345", APPLE_KEY_ID: "KEY1234567", APPLE_CLIENT_ID: "app.courtbook.mobile", APPLE_SIGNIN_KEY: ourKey,
  DELETION_INTENT_SECRET: "i".repeat(40), SUPABASE_SERVICE_ROLE_KEY: "service", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
};
const intentRoute = await import("./intent/route");
const deleteRoute = await import("./route");
const post = (body?: unknown) => new Request("https://courtbook.example/api/account/apple-delete", {
  method: "POST", headers: { authorization: "Bearer a.b.c", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function intentFor(user: string) {
  bearerUser = user;
  const r = await intentRoute.POST(post());
  return ((await r.json()) as { intent: string }).intent;
}

beforeEach(() => {
  calls.length = 0; metadata.length = 0; reported.length = 0; claimed = false;
  bearerUser = A; recent = true; closeAnswer = { error: null }; statusRows = { data: [], error: null }; revokeStatus = 200;
  markFails = null; keysStatus = 200; tokenStatus = 200;
  identities = [{ provider: "email", identity_data: { sub: A } }, { provider: "apple", identity_data: { sub: "apple-A" } }];
  appleSubForCode = { "CODE-A": "apple-A", "CODE-B": "apple-B" };
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.stubGlobal("fetch", appleFetch);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("off unless configured; bearer required", () => {
  it("without the Apple credentials or the intent secret, both routes answer 503 and touch nothing", async () => {
    for (const missing of ["APPLE_SIGNIN_KEY", "DELETION_INTENT_SECRET"]) {
      vi.stubEnv(missing, "");
      for (const r of [await intentRoute.POST(post()), await deleteRoute.POST(post({ method: "fallback", intent: "x" }))]) {
        expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ error: "not_configured" });
      }
      vi.stubEnv(missing, ENV[missing as keyof typeof ENV]);
    }
    expect(calls).toEqual([]);
  });
  it("no valid bearer: 401", async () => {
    bearerUser = null;
    expect((await intentRoute.POST(post())).status).toBe(401);
    expect((await deleteRoute.POST(post({ method: "fallback", intent: "x" }))).status).toBe(401);
  });
  it("malformed bodies: 400, nothing else runs", async () => {
    for (const body of [undefined, {}, { method: "apple", intent: "x" }, { method: "apple", code: 5, intent: "x" }, { method: "x", intent: "x" }, { method: "fallback" }]) {
      const r = await deleteRoute.POST(post(body));
      expect(r.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });
});

describe("the Apple path end to end (fake Apple, mocked Supabase)", () => {
  it("intent → … → close → revoke → mark → processing (claim, ban, data, sign-in deleted): 200 closed, revocation done", async () => {
    const intent = await intentFor(A);
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ closed: true, revocation: "done" });
    const i = (s: string) => calls.indexOf(s);
    expect(i("service:getUser")).toBeLessThan(i("user:recently_authenticated"));
    expect(i("user:recently_authenticated")).toBeLessThan(i("apple:/auth/token"));
    expect(i("apple:/auth/token")).toBeLessThan(i("apple:/auth/keys"));
    expect(i("apple:/auth/keys")).toBeLessThan(i("user:close_my_account"));
    expect(i("user:close_my_account")).toBeLessThan(i("apple:/auth/revoke"));
    expect(i("apple:/auth/revoke")).toBeLessThan(i("service:mark"));
    expect(i("service:mark")).toBeLessThan(i("service:claim_deletion"));     // revoke + mark BEFORE the processing
    expect(calls).toContain("service:deleteUser");
    expect(metadata[0]).toEqual({ apple_revocation: "done" });
    expect(JSON.stringify(calls)).not.toMatch(/RT|AT/);
  });
  it("TWO ACCOUNTS: A's intent, but Apple signed the app into B (B's bearer, B's valid code) → 403 account_mismatch; nothing of B touched", async () => {
    const intentA = await intentFor(A);
    bearerUser = B;
    identities = [{ provider: "apple", identity_data: { sub: "apple-B" } }];
    calls.length = 0;
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-B", intent: intentA }));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ closed: false, error: "account_mismatch" });
    expect(calls).toEqual([]);
  });
  it("still A, but the Apple sheet used B's Apple ID → 422 wrong_apple_account, nothing closed", async () => {
    const intent = await intentFor(A);
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-B", intent }));
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ closed: false, error: "wrong_apple_account" });
    expect(calls).not.toContain("user:close_my_account");
  });
  it("stale session: 409 reauth_required before Apple is contacted", async () => {
    const intent = await intentFor(A);
    recent = false;
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
    expect(r.status).toBe(409);
    expect(calls.some((c) => c.startsWith("apple:"))).toBe(false);
  });
  it("database refusal (definite, with a code): 409, nothing revoked, record not consulted", async () => {
    const intent = await intentFor(A);
    closeAnswer = { error: { message: "staff_role", code: "P0001" } };
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ closed: false, error: "staff_role" });
    expect(calls).not.toContain("apple:/auth/revoke");
    expect(calls).not.toContain("service:status");
  });
  it("REGRESSION: the closure committed but its answer was lost → the record says closing → 200 closed and revoked", async () => {
    for (const lost of ["throw", { error: { message: "TypeError: fetch failed" } }] as const) {
      calls.length = 0; claimed = false;
      const intent = await intentFor(A);
      closeAnswer = lost; statusRows = { data: [{ status: "closing" }], error: null };
      const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
      expect(await r.json()).toEqual({ closed: true, revocation: "done" });
      expect(calls.indexOf("service:status")).toBeLessThan(calls.indexOf("apple:/auth/revoke"));
    }
  });
  it("answer lost and the record unreadable → 202 closed: unknown (never 'nothing changed'), alerted, nothing revoked", async () => {
    const intent = await intentFor(A);
    closeAnswer = "throw"; statusRows = { data: null, error: { message: "timeout" } };
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ closed: "unknown", error: "close_result_unknown" });
    expect(reported).toEqual(["appleCloseResultUnknown"]);
    expect(calls).not.toContain("apple:/auth/revoke");
  });
  it("answer lost and a readable record shows no closure → still 202 unknown (the request may yet commit), nothing revoked", async () => {
    const intent = await intentFor(A);
    closeAnswer = "throw"; statusRows = { data: [], error: null };
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ closed: "unknown", error: "close_result_unknown" });
    expect(calls).not.toContain("apple:/auth/revoke");
  });
  it("Apple refuses the revocation after closing: still 200 closed, revocation failed, alerted, processed", async () => {
    const intent = await intentFor(A);
    revokeStatus = 400;
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
    expect(await r.json()).toEqual({ closed: true, revocation: "failed" });
    expect(reported).toContain("appleRevokeFailed");
    expect(metadata[0]).toEqual({ apple_revocation: "failed" });
    expect(calls).toContain("service:deleteUser");
  });
  it("fallback (Apple cancelled or unavailable): closed, revocation skipped and alerted, no Apple request", async () => {
    const intent = await intentFor(A);
    const r = await deleteRoute.POST(post({ method: "fallback", intent }));
    expect(await r.json()).toEqual({ closed: true, revocation: "skipped" });
    expect(reported).toContain("appleRevocationSkipped");
    expect(calls.some((c) => c.startsWith("apple:"))).toBe(false);
  });
  it("an account with no Apple identity: 409 not_apple_account (the ordinary deletion applies)", async () => {
    const intent = await intentFor(A);
    identities = [{ provider: "email", identity_data: { sub: A } }];
    expect((await deleteRoute.POST(post({ method: "fallback", intent }))).status).toBe(409);
  });
});

describe("fourth review, point 1: Apple's token exchange or signing keys out of service", () => {
  it("token endpoint down (503) or keys endpoint down (503/500): 503 apple_unavailable, nothing closed (the app then offers the email code)", async () => {
    const { resetAppleKeysForTests } = await import("@/lib/apple/routeDeps");
    for (const [t, k] of [[503, 200], [500, 200], [200, 503], [200, 500]]) {
      calls.length = 0;
      resetAppleKeysForTests();   // a signing-key outage only shows when the keys are not already cached
      const intent = await intentFor(A);
      tokenStatus = t; keysStatus = k;
      const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
      expect(r.status).toBe(503);
      expect(await r.json()).toEqual({ closed: false, error: "apple_unavailable" });
      expect(calls).not.toContain("user:close_my_account");
    }
  });
  it("…and the fallback then closes the account with the same intent", async () => {
    const intent = await intentFor(A);
    tokenStatus = 503;
    await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
    const r = await deleteRoute.POST(post({ method: "fallback", intent }));
    expect(await r.json()).toEqual({ closed: true, revocation: "skipped" });
  });
});

describe("fourth review, point 2: only Postgres's own refusals are definite; infrastructure errors go to recovery", async () => {
  const { closeOutcomeOf } = await import("@/lib/apple/routeDeps");
  it("definite: SQLSTATE classes P0, 22, 23, 28, 40, 42 with a 4xx status (or none)", () => {
    expect(closeOutcomeOf({ error: null })).toEqual({ ok: true });
    expect(closeOutcomeOf({ error: { message: "reauth_required", code: "P0001" }, status: 400 })).toEqual({ ok: false, code: "reauth_required" });
    expect(closeOutcomeOf({ error: { message: "staff_role", code: "P0001" } })).toEqual({ ok: false, code: "staff_role" });
    expect(closeOutcomeOf({ error: { message: "permission denied", code: "42501" }, status: 403 })).toEqual({ ok: false, code: "failed" });
    expect(closeOutcomeOf({ error: { message: "could not serialize", code: "40001" }, status: 409 })).toEqual({ ok: false, code: "failed" });
    expect(closeOutcomeOf({ error: { message: "deadlock detected", code: "40P01" }, status: 409 })).toEqual({ ok: false, code: "failed" });
  });
  it("unknown: PostgREST, gateway, transport, cancellation, connection and internal errors, and any 5xx", () => {
    for (const r of [
      { error: { message: "Could not connect", code: "PGRST000" }, status: 503 },
      { error: { message: "connection error", code: "PGRST001" }, status: 503 },
      { error: { message: "schema cache", code: "PGRST002" }, status: 503 },
      { error: { message: "pool timeout", code: "PGRST003" }, status: 504 },
      { error: { message: "canceling statement due to statement timeout", code: "57014" }, status: 500 },
      { error: { message: "terminating connection", code: "57P01" }, status: 503 },
      { error: { message: "connection failure", code: "08006" }, status: 503 },
      { error: { message: "too many connections", code: "53300" }, status: 503 },
      { error: { message: "internal", code: "XX000" }, status: 500 },
      { error: { message: "reauth_required", code: "P0001" }, status: 502 },   // a refusal code behind a gateway error: not trusted
      { error: { message: "<html>502 Bad Gateway</html>", code: "" }, status: 502 },
      { error: { message: "TypeError: fetch failed" }, status: 0 },
      { error: { message: "AbortError" } },
      null,
    ]) expect(closeOutcomeOf(r)).toEqual({ ok: "unknown" });
  });
  it("REGRESSION (route): a PostgREST time-out or an internal error after the closure committed → recovery finds it → closed and revoked", async () => {
    for (const lost of [{ error: { message: "pool timeout", code: "PGRST003" }, status: 504 }, { error: { message: "internal", code: "XX000" }, status: 500 },
                        { error: { message: "canceling statement", code: "57014" }, status: 500 }]) {
      calls.length = 0; claimed = false;
      const intent = await intentFor(A);
      closeAnswer = lost; statusRows = { data: [{ status: "closing" }], error: null };
      const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
      expect(await r.json()).toEqual({ closed: true, revocation: "done" });
      expect(calls).toContain("service:status");
    }
  });
  it("REGRESSION (route): the same errors with no closure found → 202 unknown, never 'nothing changed'", async () => {
    const intent = await intentFor(A);
    closeAnswer = { error: { message: "Could not connect", code: "PGRST000" }, status: 503 }; statusRows = { data: [], error: null };
    const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ closed: "unknown", error: "close_result_unknown" });
  });
});

describe("fourth review, point 3: revocation-marker writes are checked", () => {
  it("an Auth error or an unconfirmed write is alerted, not taken as recorded; the account is still closed and processed", async () => {
    for (const f of ["error", "unconfirmed"] as const) {
      calls.length = 0; claimed = false; reported.length = 0;
      const intent = await intentFor(A);
      markFails = f;
      const r = await deleteRoute.POST(post({ method: "apple", code: "CODE-A", intent }));
      expect(await r.json()).toEqual({ closed: true, revocation: "done" });
      expect(reported).toContain("appleRevocationMarkFailed");
      expect(calls).toContain("service:deleteUser");
    }
  });
  it("the older-app hook's mark: an Auth error or unconfirmed write throws (the pipeline then alerts 'mark_failed')", async () => {
    const { appleRevocationHook } = await import("@/lib/apple/routeDeps");
    const hook = appleRevocationHook()!;
    const s = new AbortController().signal;
    markFails = "error";
    await expect(hook.mark(A, s)).rejects.toThrow("revocation_mark_not_confirmed");
    markFails = "unconfirmed";
    await expect(hook.mark(A, s)).rejects.toThrow("revocation_mark_not_confirmed");
    markFails = null;
    await expect(hook.mark(A, s)).resolves.toBeUndefined();
  });
});
