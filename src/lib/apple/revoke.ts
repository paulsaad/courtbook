import "server-only";
import { createPrivateKey, createPublicKey, sign, verify, type JsonWebKey, type KeyObject } from "node:crypto";

/**
 * Sign in with Apple token revocation on account deletion (store item E1; Apple TN3194). PREPARED, NOT WIRED:
 * nothing calls this yet, and it does nothing until the company's Sign in with Apple key is configured (L14, 24 Nov:
 * it runs in this Next.js backend; credentials are added only at release). Flow and decisions:
 * `docs/m5/apple-revocation.md`; the ordering lives in `deletion.ts`.
 *
 * Three separate steps, so the caller can order them (review 25 Nov, point 2):
 *   exchangeCode()       POST /auth/token: a fresh authorization code → Apple's id_token + a refresh (or access) token;
 *   verifyAppleIdToken() the id_token's RS256 signature against Apple's published keys, issuer, audience (our client
 *                        id), expiry and issue time; only then is its `sub` (the Apple user id) trusted (point 1);
 *   revokeToken()        POST /auth/revoke.
 * client_id is the iOS app's bundle id; client_secret is an ES256 JWT signed with the company key.
 *
 * Nothing here logs or returns a token: tokens travel inside AppleToken, which serialises as "[apple token]".
 */

export const APPLE_ORIGIN = "https://appleid.apple.com";
const TIMEOUT_MS = 8_000;
const CLOCK_SKEW_S = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;

export type AppleConfig = { teamId: string; keyId: string; clientId: string; key: KeyObject };
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** A token from Apple, kept out of logs and JSON by construction. */
export class AppleToken {
  readonly #value: string;
  constructor(value: string, readonly hint: "refresh_token" | "access_token") { this.#value = value; }
  reveal(): string { return this.#value; }
  toJSON(): string { return "[apple token]"; }
  toString(): string { return "[apple token]"; }
}

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
const fromB64url = (s: string) => Buffer.from(s, "base64url");

/** The client secret: an ES256 JWT, valid for 5 minutes (made per request; Apple allows up to 6 months). */
export function clientSecret(cfg: AppleConfig, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId, typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: cfg.teamId, iat, exp: iat + 300, aud: APPLE_ORIGIN, sub: cfg.clientId }));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: cfg.key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64url(sig)}`;
}

async function call(fetchFn: Fetch, path: string, form?: Record<string, string>, outer?: AbortSignal) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  // the caller's limit (deletion.ts bounded()) stops the request too
  if (outer?.aborted) ctl.abort();
  outer?.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const r = await fetchFn(`${APPLE_ORIGIN}${path}`, form
      ? { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), signal: ctl.signal }
      : { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal });
    let json: unknown = null;
    try { json = await r.json(); } catch { /* revoke answers 200 with an empty body */ }
    return { ok: r.ok, status: r.status, json: (json ?? {}) as Record<string, unknown> };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- step 1: exchange the code

export type ExchangeResult =
  | { ok: true; idToken: string; token: AppleToken }
  | { ok: false; code: "not_configured" | "code_rejected" | "apple_unavailable" | "exchange_failed" };

export async function exchangeCode(cfg: AppleConfig | null, code: string, opts: { fetchFn?: Fetch; now?: Date; signal?: AbortSignal } = {}): Promise<ExchangeResult> {
  if (!cfg) return { ok: false, code: "not_configured" };
  if (typeof code !== "string" || !code || code.length > 2048) return { ok: false, code: "code_rejected" };
  const fetchFn = opts.fetchFn ?? (fetch as unknown as Fetch);
  try {
    const t = await call(fetchFn, "/auth/token", { grant_type: "authorization_code", code, client_id: cfg.clientId, client_secret: clientSecret(cfg, opts.now) }, opts.signal);
    if (!t.ok) {
      if (t.json.error === "invalid_grant") return { ok: false, code: "code_rejected" };
      return { ok: false, code: t.status >= 500 || t.status === 429 ? "apple_unavailable" : "exchange_failed" };
    }
    if (typeof t.json.id_token !== "string") return { ok: false, code: "exchange_failed" };
    // revoking the refresh token ends the authorization; the access token only if Apple returned no refresh token
    const token = typeof t.json.refresh_token === "string" ? new AppleToken(t.json.refresh_token, "refresh_token")
      : typeof t.json.access_token === "string" ? new AppleToken(t.json.access_token, "access_token") : null;
    if (!token) return { ok: false, code: "exchange_failed" };
    return { ok: true, idToken: t.json.id_token, token };
  } catch {
    return { ok: false, code: "apple_unavailable" };
  }
}

// ---------------------------------------------------------------- step 2: verify the id_token

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
/** Apple's published signing keys (GET /auth/keys), cached for an hour; refetched once for an unknown key id. */
export class AppleKeys {
  #keys: Jwk[] | null = null;
  #at = 0;
  constructor(private readonly fetchFn: Fetch = fetch as unknown as Fetch, private readonly clock: () => number = Date.now) {}
  async find(kid: string): Promise<Jwk | null | "unavailable"> {
    const fresh = this.#keys !== null && this.clock() - this.#at < JWKS_TTL_MS;
    if (fresh) {
      const k = this.#keys!.find((x) => x.kid === kid);
      if (k) return k;
    }
    const loaded = await this.#load();
    if (!loaded) return "unavailable";
    return this.#keys!.find((x) => x.kid === kid) ?? null;
  }
  async #load(): Promise<boolean> {
    try {
      const r = await call(this.fetchFn, "/auth/keys");
      const keys = r.ok && Array.isArray(r.json.keys) ? (r.json.keys as Jwk[]) : null;
      if (!keys) return false;
      this.#keys = keys;
      this.#at = this.clock();
      return true;
    } catch {
      return false;
    }
  }
}

export type VerifyResult =
  | { ok: true; sub: string }
  | { ok: false; code: "apple_unavailable" | "token_malformed" | "bad_algorithm" | "unknown_key" | "bad_signature" | "wrong_issuer" | "wrong_audience" | "expired" | "issued_in_future" | "no_subject" };

/** Checks an Apple id_token fully. Only `sub` of a token that passes every check is returned. */
export async function verifyAppleIdToken(idToken: string, opts: { clientId: string; keys: AppleKeys; now?: Date }): Promise<VerifyResult> {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3) return { ok: false, code: "token_malformed" };
  let header: { alg?: unknown; kid?: unknown }, claims: { iss?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; sub?: unknown };
  try {
    header = JSON.parse(fromB64url(parts[0]).toString("utf8"));
    claims = JSON.parse(fromB64url(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, code: "token_malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, code: "bad_algorithm" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, code: "unknown_key" };
  const jwk = await opts.keys.find(header.kid);
  if (jwk === "unavailable") return { ok: false, code: "apple_unavailable" };
  if (!jwk || jwk.kty !== "RSA" || (jwk.alg && jwk.alg !== "RS256")) return { ok: false, code: "unknown_key" };
  let good = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    good = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, code: "bad_signature" };
  if (claims.iss !== APPLE_ORIGIN) return { ok: false, code: "wrong_issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) return { ok: false, code: "wrong_audience" };
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S <= now) return { ok: false, code: "expired" };
  if (typeof claims.iat !== "number" || claims.iat > now + CLOCK_SKEW_S) return { ok: false, code: "issued_in_future" };
  if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, code: "no_subject" };
  return { ok: true, sub: claims.sub };
}

// ---------------------------------------------------------------- step 3: revoke

export type RevokeResult = { ok: true } | { ok: false; code: "not_configured" | "revoke_failed" | "apple_unavailable" };

export async function revokeToken(cfg: AppleConfig | null, token: AppleToken, opts: { fetchFn?: Fetch; now?: Date; signal?: AbortSignal } = {}): Promise<RevokeResult> {
  if (!cfg) return { ok: false, code: "not_configured" };
  const fetchFn = opts.fetchFn ?? (fetch as unknown as Fetch);
  try {
    const r = await call(fetchFn, "/auth/revoke", { client_id: cfg.clientId, client_secret: clientSecret(cfg, opts.now), token: token.reveal(), token_type_hint: token.hint }, opts.signal);
    if (r.ok) return { ok: true };
    return { ok: false, code: r.status >= 500 || r.status === 429 ? "apple_unavailable" : "revoke_failed" };
  } catch {
    return { ok: false, code: "apple_unavailable" };
  }
}
