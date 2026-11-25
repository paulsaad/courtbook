import "server-only";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/**
 * Sign in with Apple token revocation on account deletion (store item E1; Apple TN3194). PREPARED, NOT WIRED:
 * nothing calls this yet, and it does nothing until the company's Sign in with Apple key is configured (L14, 24 Nov:
 * it runs in this Next.js backend; credentials are added only at release). The flow it serves is in
 * `docs/m5/apple-revocation.md` (for Paul's decision).
 *
 * Apple's REST API, both endpoints `application/x-www-form-urlencoded`:
 *   POST https://appleid.apple.com/auth/token   grant_type=authorization_code, code, client_id, client_secret
 *        → { access_token, refresh_token, id_token } (the code is single-use and short-lived: minutes)
 *   POST https://appleid.apple.com/auth/revoke  client_id, client_secret, token, token_type_hint → 200, empty body
 * client_id is the iOS app's bundle id (the app signs in natively); client_secret is an ES256 JWT signed with the
 * key: header { alg ES256, kid }, claims { iss team, iat, exp, aud https://appleid.apple.com, sub client_id }.
 *
 * Nothing here logs or returns a token. Results carry short codes only.
 */

export const APPLE_ORIGIN = "https://appleid.apple.com";
const TIMEOUT_MS = 8_000;

export type AppleConfig = { teamId: string; keyId: string; clientId: string; key: KeyObject };
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type RevokeResult =
  | { ok: true }
  | { ok: false; code: "not_configured" | "code_rejected" | "wrong_apple_account" | "exchange_failed" | "revoke_failed" | "network" };

const TEAM_OR_KEY = /^[A-Z0-9]{10}$/;
const BUNDLE = /^[A-Za-z0-9.-]{3,155}$/;

/** Reads APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_CLIENT_ID and APPLE_SIGNIN_KEY (the .p8 PEM; "\n" may be escaped). */
export function appleConfig(env: Record<string, string | undefined> = process.env): AppleConfig | null {
  return parse(env).config;
}

/** null when fully configured or fully absent (absent = revocation off); otherwise what is wrong (no secret in it). */
export function appleConfigProblem(env: Record<string, string | undefined> = process.env): string | null {
  return parse(env).problem;
}

function parse(env: Record<string, string | undefined>): { config: AppleConfig | null; problem: string | null } {
  const names = ["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_CLIENT_ID", "APPLE_SIGNIN_KEY"] as const;
  const set = names.filter((n) => (env[n] ?? "").trim() !== "");
  if (set.length === 0) return { config: null, problem: null };
  if (set.length < names.length) return { config: null, problem: "apple_config_incomplete" };
  const teamId = env.APPLE_TEAM_ID!.trim(), keyId = env.APPLE_KEY_ID!.trim(), clientId = env.APPLE_CLIENT_ID!.trim();
  if (!TEAM_OR_KEY.test(teamId)) return { config: null, problem: "apple_team_id_invalid" };
  if (!TEAM_OR_KEY.test(keyId)) return { config: null, problem: "apple_key_id_invalid" };
  if (!BUNDLE.test(clientId)) return { config: null, problem: "apple_client_id_invalid" };
  let key: KeyObject;
  try {
    key = createPrivateKey(env.APPLE_SIGNIN_KEY!.replace(/\\n/g, "\n"));
  } catch {
    return { config: null, problem: "apple_key_unreadable" };
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return { config: null, problem: "apple_key_not_p256" };
  return { config: { teamId, keyId, clientId, key }, problem: null };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The client secret: an ES256 JWT, valid for 5 minutes (made per request; Apple allows up to 6 months). */
export function clientSecret(cfg: AppleConfig, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId, typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: cfg.teamId, iat, exp: iat + 300, aud: APPLE_ORIGIN, sub: cfg.clientId }));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: cfg.key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64url(sig)}`;
}

/** The "sub" claim of an id_token that came straight from Apple's token endpoint over TLS (not from the client). */
function subOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { sub?: unknown; aud?: unknown; iss?: unknown };
    return claims.iss === APPLE_ORIGIN && typeof claims.sub === "string" && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

async function post(fetchFn: Fetch, path: string, form: Record<string, string>) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchFn(`${APPLE_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: ctl.signal,
    });
    let json: unknown = null;
    try { json = await r.json(); } catch { /* revoke answers 200 with an empty body */ }
    return { ok: r.ok, status: r.status, json: (json ?? {}) as Record<string, unknown> };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Exchanges a fresh authorization code from the app (the person signs in with Apple again when deleting), checks it
 * belongs to the account being deleted (`expectedSub`: the Apple user id on that account's Apple identity), then
 * revokes the refresh token (or, without one, the access token). Nothing is revoked if the code belongs to another
 * Apple ID.
 */
export async function revokeWithCode(
  code: string, expectedSub: string,
  opts: { config?: AppleConfig | null; fetchFn?: Fetch; now?: Date } = {},
): Promise<RevokeResult> {
  const cfg = opts.config === undefined ? appleConfig() : opts.config;
  if (!cfg) return { ok: false, code: "not_configured" };
  if (!code || code.length > 2048 || !expectedSub) return { ok: false, code: "code_rejected" };
  const fetchFn = opts.fetchFn ?? (fetch as unknown as Fetch);
  const secret = () => clientSecret(cfg, opts.now ?? new Date());
  try {
    const t = await post(fetchFn, "/auth/token", { grant_type: "authorization_code", code, client_id: cfg.clientId, client_secret: secret() });
    if (!t.ok) return { ok: false, code: t.json.error === "invalid_grant" ? "code_rejected" : "exchange_failed" };
    const sub = subOf(t.json.id_token);
    if (!sub) return { ok: false, code: "exchange_failed" };
    if (sub !== expectedSub) return { ok: false, code: "wrong_apple_account" };
    // Revoking the refresh token ends the authorization (the app leaves "Apps using Apple ID"); the access token is
    // used only if Apple returned no refresh token.
    const [token, hint] = typeof t.json.refresh_token === "string" ? [t.json.refresh_token, "refresh_token"]
      : typeof t.json.access_token === "string" ? [t.json.access_token, "access_token"] : [null, null];
    if (!token || !hint) return { ok: false, code: "exchange_failed" };
    const r = await post(fetchFn, "/auth/revoke", { client_id: cfg.clientId, client_secret: secret(), token, token_type_hint: hint });
    if (!r.ok) return { ok: false, code: "revoke_failed" };
    return { ok: true };
  } catch {
    return { ok: false, code: "network" };
  }
}
