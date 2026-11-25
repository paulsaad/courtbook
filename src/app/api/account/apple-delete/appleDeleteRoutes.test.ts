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
let closeAnswer: { error: { message: string; code?: string } | null } | "throw";
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
      if (fn === "close_my_account") { if (closeAnswer === "throw") throw new TypeError("fetch failed"); return { data: { status: "closing" }, ...closeAnswer }; }
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
        if (attrs.app_metadata) { calls.push("service:mark"); metadata.push(attrs.app_metadata); } else calls.push("service:ban");
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
  if (path === "/auth/keys") return json(200, { keys: [JWK] });
  if (path === "/auth/token") {
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

describe("closeOutcomeOf: only an answer with an error code is definite", async () => {
  const { closeOutcomeOf } = await import("@/lib/apple/routeDeps");
  it("maps answers", () => {
    expect(closeOutcomeOf({ error: null })).toEqual({ ok: true });
    expect(closeOutcomeOf({ error: { message: "reauth_required", code: "P0001" } })).toEqual({ ok: false, code: "reauth_required" });
    expect(closeOutcomeOf({ error: { message: "permission denied", code: "42501" } })).toEqual({ ok: false, code: "failed" });
    expect(closeOutcomeOf({ error: { message: "TypeError: fetch failed" } })).toEqual({ ok: "unknown" });
    expect(closeOutcomeOf({ error: { message: "AbortError", code: "" } })).toEqual({ ok: "unknown" });
    expect(closeOutcomeOf(null)).toEqual({ ok: "unknown" });
  });
});
