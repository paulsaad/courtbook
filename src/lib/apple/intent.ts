import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The deletion intent (review 25 Nov, point 1: no account switching during Apple reauthentication).
 *
 * Before the Apple sheet, the app asks the server for an intent WITH ITS ORIGINAL SESSION. The intent is an HMAC-signed
 * statement "account <id> asked to delete itself, until <exp>". The deletion call must carry it, and the server
 * refuses unless the account authenticated on that call is the same account the intent was issued to. So if the Apple
 * sign-in leads to a different CourtBook account, nothing is deleted, whatever the app does.
 *
 * Secret: DELETION_INTENT_SECRET (at least 32 characters). Absent → no intent can be issued and the route stays off.
 * The intent carries an account id and times only; it is not a credential (the call still needs that account's
 * recent session), so a replay within its ten minutes can only ever target the account it names.
 */
export const INTENT_TTL_S = 600;

export function intentSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = (env.DELETION_INTENT_SECRET ?? "").trim();
  return s.length >= 32 ? s : null;
}

const mac = (secret: string, body: string) => createHmac("sha256", secret).update(`courtbook-deletion-intent.v1.${body}`).digest("base64url");

export function signIntent(secret: string, userId: string, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const body = Buffer.from(JSON.stringify({ u: userId, iat, exp: iat + INTENT_TTL_S, n: randomBytes(9).toString("base64url") })).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

export type IntentCheck = { ok: true; userId: string } | { ok: false; code: "intent_invalid" | "intent_expired" };

export function verifyIntent(secret: string, token: unknown, now: Date = new Date()): IntentCheck {
  if (typeof token !== "string" || token.length > 512) return { ok: false, code: "intent_invalid" };
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false, code: "intent_invalid" };
  const want = Buffer.from(mac(secret, body)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, code: "intent_invalid" };
  let claims: { u?: unknown; iat?: unknown; exp?: unknown };
  try { claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, code: "intent_invalid" }; }
  if (typeof claims.u !== "string" || typeof claims.exp !== "number" || typeof claims.iat !== "number") return { ok: false, code: "intent_invalid" };
  const t = Math.floor(now.getTime() / 1000);
  if (claims.exp <= t || claims.iat > t + 60) return { ok: false, code: "intent_expired" };
  return { ok: true, userId: claims.u };
}
