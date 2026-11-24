/**
 * Request checks shared by the account-deletion routes. Pure functions: no Supabase, no environment reads except the
 * secret passed in.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A request from a page of this site: Origin present and equal to this site's origin, JSON body. A form or link on
 * another site cannot meet both (a cross-site JSON POST needs a CORS preflight, which these routes never answer), so
 * the browser's cookie alone cannot close or process an account.
 */
export function sameSiteJson(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

export async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch { return null; }
}

/** At least this long, so a short or placeholder value never authorises anything. */
export const MIN_SECRET_LENGTH = 32;

/**
 * The retry route's caller: "Authorization: Bearer <CRON_SECRET>" (how Vercel Cron sends it). Compared as fixed-length
 * digests in constant time. No secret, or one too short, means the route is not configured: nobody is authorised.
 */
export function bearerMatches(header: string | null, secret: string | undefined): "ok" | "unset" | "no" {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return "unset";
  const a = createHash("sha256").update(header ?? "").digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b) ? "ok" : "no";
}
