/**
 * The only URLs CourtBook gives a payment provider (M12.1). They come from configuration, never from the incoming
 * request: a forged Host or X-Forwarded-Host header must not be able to send a player, or a provider's callback,
 * anywhere else.
 *
 * PAYMENT_SITE_URL is the website's origin, e.g. https://courtbook.example (https only; http only for localhost).
 * Anything else — a path, a query, credentials, another scheme, an unparsable value — counts as not configured.
 */
export function paymentSiteOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.PAYMENT_SITE_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!(u.protocol === "https:" || (local && u.protocol === "http:"))) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return u.origin;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function attemptReturnUrl(origin: string, attemptId: string): string {
  if (!isUuid(attemptId)) throw new Error("bad attempt id");
  return `${origin}/pay/return?attempt=${attemptId}`;
}

/**
 * Where the provider sends a player who paid from the app (M12.4). Deliberately carries nothing — no attempt, no
 * payment, no token: the page only hands control back to the app, which then asks the server where the payment stands.
 */
export function appReturnUrl(origin: string): string {
  return `${origin}/pay/app-return`;
}

export function providerCallbackUrl(origin: string, provider: string): string {
  if (!/^[a-z]{1,20}$/.test(provider)) throw new Error("bad provider name");
  return `${origin}/api/pay/callback/${provider}`;
}

/** A payment page the provider handed us must itself be https before we send a player to it. */
export function isSafeRedirect(url: string): boolean {
  try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}
