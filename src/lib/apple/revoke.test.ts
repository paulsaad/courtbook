import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { generateKeyPairSync, verify } from "node:crypto";
import { APPLE_ORIGIN, appleConfig, appleConfigProblem, clientSecret, revokeWithCode, type Fetch } from "./revoke";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ENV = { APPLE_TEAM_ID: "ABCDE12345", APPLE_KEY_ID: "KEY1234567", APPLE_CLIENT_ID: "app.courtbook.mobile", APPLE_SIGNIN_KEY: PEM };
const cfg = appleConfig(ENV)!;
const NOW = new Date("2026-11-25T12:00:00Z");
const idToken = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

/** A fake Apple: records requests (never real network); answers per path. */
function apple(answers: Record<string, { status: number; body?: unknown } | "throw">) {
  const calls: { path: string; form: URLSearchParams; headers: Record<string, string> }[] = [];
  const fetchFn: Fetch = async (url, init) => {
    const path = url.replace(APPLE_ORIGIN, "");
    calls.push({ path, form: new URLSearchParams(init.body), headers: init.headers });
    const a = answers[path];
    if (!a || a === "throw") throw new Error("network down");
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => { if (a.body === undefined) throw new Error("empty"); return a.body; } };
  };
  return { fetchFn, calls };
}
const tokenOk = (sub = "001234.apple-user") => ({ status: 200, body: { access_token: "AT-secret", refresh_token: "RT-secret", id_token: idToken({ iss: APPLE_ORIGIN, sub, aud: "app.courtbook.mobile" }) } });

describe("configuration", () => {
  it("absent: off, and not a problem", () => {
    expect(appleConfig({})).toBeNull();
    expect(appleConfigProblem({})).toBeNull();
  });
  it("complete and valid: on", () => {
    expect(appleConfigProblem(ENV)).toBeNull();
    expect(cfg.clientId).toBe("app.courtbook.mobile");
    // the PEM may arrive with escaped newlines (one-line environment variable)
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
    const jwt = clientSecret(cfg, NOW);
    const [h, b, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    const iat = NOW.getTime() / 1000;
    expect(JSON.parse(Buffer.from(b, "base64url").toString())).toEqual({ iss: "ABCDE12345", iat, exp: iat + 300, aud: APPLE_ORIGIN, sub: "app.courtbook.mobile" });
    expect(Buffer.from(s, "base64url")).toHaveLength(64);   // raw r||s, as JWS requires (not DER)
    expect(verify("sha256", Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("revokeWithCode", () => {
  it("exchanges the code, checks the Apple ID, revokes the refresh token", async () => {
    const a = apple({ "/auth/token": tokenOk(), "/auth/revoke": { status: 200 } });
    expect(await revokeWithCode("CODE-1", "001234.apple-user", { config: cfg, fetchFn: a.fetchFn, now: NOW })).toEqual({ ok: true });
    expect(a.calls.map((c) => c.path)).toEqual(["/auth/token", "/auth/revoke"]);
    const [t, r] = a.calls;
    expect(t.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(t.form)).toMatchObject({ grant_type: "authorization_code", code: "CODE-1", client_id: "app.courtbook.mobile" });
    expect(t.form.get("client_secret")!.split(".")).toHaveLength(3);
    expect(Object.fromEntries(r.form)).toMatchObject({ client_id: "app.courtbook.mobile", token: "RT-secret", token_type_hint: "refresh_token" });
  });
  it("without a refresh token, the access token is revoked", async () => {
    const a = apple({ "/auth/token": { status: 200, body: { access_token: "AT", id_token: idToken({ iss: APPLE_ORIGIN, sub: "u1" }) } }, "/auth/revoke": { status: 200 } });
    expect(await revokeWithCode("C", "u1", { config: cfg, fetchFn: a.fetchFn })).toEqual({ ok: true });
    expect(a.calls[1].form.get("token_type_hint")).toBe("access_token");
  });
  it("a code from another Apple ID revokes nothing", async () => {
    const a = apple({ "/auth/token": tokenOk("someone-else"), "/auth/revoke": { status: 200 } });
    expect(await revokeWithCode("C", "001234.apple-user", { config: cfg, fetchFn: a.fetchFn })).toEqual({ ok: false, code: "wrong_apple_account" });
    expect(a.calls.map((c) => c.path)).toEqual(["/auth/token"]);
  });
  it("an id_token not issued by Apple, or without sub, is not trusted", async () => {
    for (const body of [{ refresh_token: "RT", id_token: idToken({ iss: "https://evil.example", sub: "001234.apple-user" }) },
                        { refresh_token: "RT", id_token: idToken({ iss: APPLE_ORIGIN }) }, { refresh_token: "RT", id_token: "garbage" }, { refresh_token: "RT" }]) {
      const a = apple({ "/auth/token": { status: 200, body }, "/auth/revoke": { status: 200 } });
      expect(await revokeWithCode("C", "001234.apple-user", { config: cfg, fetchFn: a.fetchFn })).toEqual({ ok: false, code: "exchange_failed" });
      expect(a.calls).toHaveLength(1);
    }
  });
  it("Apple's refusals and outages map to short codes", async () => {
    const run = (answers: Parameters<typeof apple>[0]) => revokeWithCode("C", "001234.apple-user", { config: cfg, fetchFn: apple(answers).fetchFn });
    expect(await run({ "/auth/token": { status: 400, body: { error: "invalid_grant" } } })).toEqual({ ok: false, code: "code_rejected" });
    expect(await run({ "/auth/token": { status: 400, body: { error: "invalid_client" } } })).toEqual({ ok: false, code: "exchange_failed" });
    expect(await run({ "/auth/token": { status: 503 } })).toEqual({ ok: false, code: "exchange_failed" });
    expect(await run({ "/auth/token": tokenOk(), "/auth/revoke": { status: 400, body: { error: "invalid_request" } } })).toEqual({ ok: false, code: "revoke_failed" });
    expect(await run({ "/auth/token": "throw" })).toEqual({ ok: false, code: "network" });
    expect(await run({ "/auth/token": tokenOk(), "/auth/revoke": "throw" })).toEqual({ ok: false, code: "network" });
  });
  it("not configured, or no code: nothing is sent", async () => {
    const a = apple({});
    expect(await revokeWithCode("C", "u", { config: null, fetchFn: a.fetchFn })).toEqual({ ok: false, code: "not_configured" });
    expect(await revokeWithCode("", "u", { config: cfg, fetchFn: a.fetchFn })).toEqual({ ok: false, code: "code_rejected" });
    expect(await revokeWithCode("C", "", { config: cfg, fetchFn: a.fetchFn })).toEqual({ ok: false, code: "code_rejected" });
    expect(a.calls).toHaveLength(0);
  });
  it("no result ever contains a token", async () => {
    const a = apple({ "/auth/token": tokenOk(), "/auth/revoke": { status: 400 } });
    const r = await revokeWithCode("CODE-1", "001234.apple-user", { config: cfg, fetchFn: a.fetchFn });
    expect(JSON.stringify(r)).not.toMatch(/RT-secret|AT-secret|CODE-1/);
  });
});
