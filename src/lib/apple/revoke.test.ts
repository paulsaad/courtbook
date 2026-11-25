import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createSign, generateKeyPairSync, verify } from "node:crypto";
import {
  APPLE_ORIGIN, AppleKeys, AppleToken, appleConfig, appleConfigProblem, clientSecret, exchangeCode, revokeToken,
  verifyAppleIdToken, type Fetch,
} from "./revoke";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ENV = { APPLE_TEAM_ID: "ABCDE12345", APPLE_KEY_ID: "KEY1234567", APPLE_CLIENT_ID: "app.courtbook.mobile", APPLE_SIGNIN_KEY: PEM };
const cfg = appleConfig(ENV)!;
const NOW = new Date("2026-11-25T12:00:00Z");
const NOW_S = NOW.getTime() / 1000;

// Apple's id_token signing key (RS256) and a stranger's key, for signature tests
const apple = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...apple.publicKey.export({ format: "jwk" }), kid: "AK1", alg: "RS256", use: "sig" };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(claims: Record<string, unknown> = {}, opts: { kid?: string; alg?: string; key?: typeof apple.privateKey } = {}) {
  const head = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "AK1" });
  const body = b64({ iss: APPLE_ORIGIN, aud: "app.courtbook.mobile", sub: "001234.apple-user", iat: NOW_S - 5, exp: NOW_S + 600, ...claims });
  const s = createSign("RSA-SHA256"); s.update(`${head}.${body}`);
  return `${head}.${body}.${s.sign(opts.key ?? apple.privateKey).toString("base64url")}`;
}

/** A fake Apple: records requests (never real network); answers per path. */
function fakeApple(answers: Record<string, { status: number; body?: unknown } | "throw">) {
  const calls: { path: string; form: URLSearchParams; method: string }[] = [];
  const fetchFn: Fetch = async (url, init) => {
    const path = url.replace(APPLE_ORIGIN, "");
    calls.push({ path, form: new URLSearchParams(init.body ?? ""), method: init.method });
    const a = answers[path];
    if (!a || a === "throw") throw new Error("network down");
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.body === undefined) throw new Error("empty"); return a.body; } };
  };
  return { fetchFn, calls };
}
const keysOk = { "/auth/keys": { status: 200, body: { keys: [JWK] } } };
const verifyWith = (token: string, extra: Parameters<typeof fakeApple>[0] = keysOk) =>
  verifyAppleIdToken(token, { clientId: "app.courtbook.mobile", keys: new AppleKeys(fakeApple(extra).fetchFn, () => NOW.getTime()), now: NOW });

describe("configuration", () => {
  it("absent: off, and not a problem; complete: on (escaped newlines accepted)", () => {
    expect(appleConfig({})).toBeNull();
    expect(appleConfigProblem({})).toBeNull();
    expect(appleConfigProblem(ENV)).toBeNull();
    expect(appleConfigProblem({ ...ENV, APPLE_SIGNIN_KEY: PEM.replace(/\n/g, "\\n") })).toBeNull();
  });
  it("partial or malformed: a named problem, never the secret", () => {
    expect(appleConfigProblem({ APPLE_TEAM_ID: "ABCDE12345" })).toBe("apple_config_incomplete");
    expect(appleConfigProblem({ ...ENV, APPLE_TEAM_ID: "abc" })).toBe("apple_team_id_invalid");
    expect(appleConfigProblem({ ...ENV, APPLE_KEY_ID: "short" })).toBe("apple_key_id_invalid");
    expect(appleConfigProblem({ ...ENV, APPLE_CLIENT_ID: "bad id!" })).toBe("apple_client_id_invalid");
    expect(appleConfigProblem({ ...ENV, APPLE_SIGNIN_KEY: "not a key" })).toBe("apple_key_unreadable");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(appleConfigProblem({ ...ENV, APPLE_SIGNIN_KEY: rsa })).toBe("apple_key_not_p256");
  });
});

describe("client secret", () => {
  it("is an ES256 JWT with Apple's claims, valid 5 minutes, signed by the key", () => {
    const [h, b, s] = clientSecret(cfg, NOW).split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    expect(JSON.parse(Buffer.from(b, "base64url").toString())).toEqual({ iss: "ABCDE12345", iat: NOW_S, exp: NOW_S + 300, aud: APPLE_ORIGIN, sub: "app.courtbook.mobile" });
    expect(Buffer.from(s, "base64url")).toHaveLength(64);   // raw r||s, as JWS requires (not DER)
    expect(verify("sha256", Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("step 1: exchangeCode", () => {
  it("sends the code with our client id and secret; returns the id_token and the refresh token, wrapped", async () => {
    const a = fakeApple({ "/auth/token": { status: 200, body: { id_token: "IDT", refresh_token: "RT-secret", access_token: "AT-secret" } } });
    const r = await exchangeCode(cfg, "CODE-1", { fetchFn: a.fetchFn, now: NOW });
    expect(r.ok && r.idToken).toBe("IDT");
    expect(r.ok && r.token.hint).toBe("refresh_token");
    expect(JSON.stringify(r)).not.toMatch(/RT-secret|AT-secret/);   // the token never serialises
    expect(Object.fromEntries(a.calls[0].form)).toMatchObject({ grant_type: "authorization_code", code: "CODE-1", client_id: "app.courtbook.mobile" });
  });
  it("without a refresh token, the access token is kept; without either, it fails", async () => {
    const r = await exchangeCode(cfg, "C", { fetchFn: fakeApple({ "/auth/token": { status: 200, body: { id_token: "I", access_token: "A" } } }).fetchFn });
    expect(r.ok && r.token.hint).toBe("access_token");
    expect(await exchangeCode(cfg, "C", { fetchFn: fakeApple({ "/auth/token": { status: 200, body: { id_token: "I" } } }).fetchFn })).toEqual({ ok: false, code: "exchange_failed" });
  });
  it("refusals and outages map to short codes; nothing sent without configuration or code", async () => {
    const run = (a: Parameters<typeof fakeApple>[0]) => exchangeCode(cfg, "C", { fetchFn: fakeApple(a).fetchFn });
    expect(await run({ "/auth/token": { status: 400, body: { error: "invalid_grant" } } })).toEqual({ ok: false, code: "code_rejected" });
    expect(await run({ "/auth/token": { status: 400, body: { error: "invalid_client" } } })).toEqual({ ok: false, code: "exchange_failed" });
    expect(await run({ "/auth/token": { status: 503 } })).toEqual({ ok: false, code: "apple_unavailable" });
    expect(await run({ "/auth/token": "throw" })).toEqual({ ok: false, code: "apple_unavailable" });
    const a = fakeApple({});
    expect(await exchangeCode(null, "C", { fetchFn: a.fetchFn })).toEqual({ ok: false, code: "not_configured" });
    expect(await exchangeCode(cfg, "", { fetchFn: a.fetchFn })).toEqual({ ok: false, code: "code_rejected" });
    expect(a.calls).toHaveLength(0);
  });
});

describe("step 2: verifyAppleIdToken (signature, issuer, audience, expiry)", () => {
  it("a token signed by Apple's published key, for our app, unexpired: its sub", async () => {
    expect(await verifyWith(idToken())).toEqual({ ok: true, sub: "001234.apple-user" });
    expect(await verifyWith(idToken({ aud: ["other", "app.courtbook.mobile"] }))).toEqual({ ok: true, sub: "001234.apple-user" });
  });
  it("refuses a token signed by another key, a tampered payload, or a non-RS256 algorithm", async () => {
    expect(await verifyWith(idToken({}, { key: stranger.privateKey }))).toEqual({ ok: false, code: "bad_signature" });
    const [h, , s] = idToken().split(".");
    expect(await verifyWith(`${h}.${b64({ iss: APPLE_ORIGIN, aud: "app.courtbook.mobile", sub: "attacker", iat: NOW_S, exp: NOW_S + 600 })}.${s}`)).toEqual({ ok: false, code: "bad_signature" });
    for (const alg of ["none", "HS256", "ES256"]) expect(await verifyWith(idToken({}, { alg }))).toEqual({ ok: false, code: "bad_algorithm" });
  });
  it("refuses the wrong issuer, another app's audience, an expired token and one issued in the future", async () => {
    expect(await verifyWith(idToken({ iss: "https://evil.example" }))).toEqual({ ok: false, code: "wrong_issuer" });
    expect(await verifyWith(idToken({ aud: "com.other.app" }))).toEqual({ ok: false, code: "wrong_audience" });
    expect(await verifyWith(idToken({ exp: NOW_S - 61 }))).toEqual({ ok: false, code: "expired" });
    expect(await verifyWith(idToken({ exp: undefined }))).toEqual({ ok: false, code: "expired" });
    expect(await verifyWith(idToken({ iat: NOW_S + 3600 }))).toEqual({ ok: false, code: "issued_in_future" });
    expect(await verifyWith(idToken({ sub: "" }))).toEqual({ ok: false, code: "no_subject" });
  });
  it("an unknown key id is refetched once, then refused; Apple's keys unreachable is an outage, not a verdict", async () => {
    const a = fakeApple(keysOk);
    const keys = new AppleKeys(a.fetchFn, () => NOW.getTime());
    expect(await verifyAppleIdToken(idToken(), { clientId: "app.courtbook.mobile", keys, now: NOW })).toMatchObject({ ok: true });
    expect(await verifyAppleIdToken(idToken({}, { kid: "AK9" }), { clientId: "app.courtbook.mobile", keys, now: NOW })).toEqual({ ok: false, code: "unknown_key" });
    expect(a.calls.filter((c) => c.path === "/auth/keys")).toHaveLength(2);   // cached for AK1; one refetch for AK9
    expect(await verifyWith(idToken(), { "/auth/keys": "throw" })).toEqual({ ok: false, code: "apple_unavailable" });
    expect(await verifyWith(idToken(), { "/auth/keys": { status: 500 } })).toEqual({ ok: false, code: "apple_unavailable" });
  });
  it("malformed tokens are refused before any key lookup", async () => {
    for (const t of ["", "a.b", "a.b.c.d", "!!.!!.!!"]) expect((await verifyWith(t)).ok).toBe(false);
  });
});

describe("step 3: revokeToken", () => {
  it("revokes with the hint; refusals and outages are distinguished", async () => {
    const a = fakeApple({ "/auth/revoke": { status: 200 } });
    expect(await revokeToken(cfg, new AppleToken("RT-secret", "refresh_token"), { fetchFn: a.fetchFn })).toEqual({ ok: true });
    expect(Object.fromEntries(a.calls[0].form)).toMatchObject({ client_id: "app.courtbook.mobile", token: "RT-secret", token_type_hint: "refresh_token" });
    const t = new AppleToken("X", "refresh_token");
    expect(await revokeToken(cfg, t, { fetchFn: fakeApple({ "/auth/revoke": { status: 400 } }).fetchFn })).toEqual({ ok: false, code: "revoke_failed" });
    expect(await revokeToken(cfg, t, { fetchFn: fakeApple({ "/auth/revoke": { status: 503 } }).fetchFn })).toEqual({ ok: false, code: "apple_unavailable" });
    expect(await revokeToken(cfg, t, { fetchFn: fakeApple({ "/auth/revoke": "throw" }).fetchFn })).toEqual({ ok: false, code: "apple_unavailable" });
    expect(await revokeToken(null, t)).toEqual({ ok: false, code: "not_configured" });
  });
  it("AppleToken never prints its value", () => {
    const t = new AppleToken("RT-secret", "refresh_token");
    expect(`${t}`).toBe("[apple token]");
    expect(JSON.stringify({ t })).toBe('{"t":"[apple token]"}');
  });
});
