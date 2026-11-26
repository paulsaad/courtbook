/**
 * What to tell a person when sending or checking an email sign-in code fails. Shared with the app (mobile/shared).
 * Supabase's own error text is never shown: it is English server wording ("Error sending magic link email") and can
 * blame the wrong thing. A dropped connection must not read as "your code is wrong" (Mission 3A).
 */
export type AuthErrorLike = { name?: string; status?: number; code?: string; message?: string } | null | undefined;

export const AUTH_TEXT = {
  offline: "Couldn't reach CourtBook. Check your connection and try again.",
  rate: "Too many requests. Wait a minute and try again.",
  badEmail: "That email address doesn't look right. Check it and try again.",
  sendFailed: "We couldn't send the code just now. Try again in a minute.",
  wrongCode: "That code is wrong or expired. Check the latest email, or request a new one.",
  server: "Something went wrong on our side. Try again in a minute.",
} as const;

function offline(e: NonNullable<AuthErrorLike>): boolean {
  // auth-js (2.119) also names a server answer of 500–530 "AuthRetryableFetchError": that is the server failing (for a
  // code email, "Error sending … email"), not this phone being offline. Only no answer at all (status 0) is offline.
  if (typeof e.status === "number" && e.status >= 500) return false;
  return e.name === "AuthRetryableFetchError" || e.status === 0 || /failed to fetch|network request failed|networkerror|load failed/i.test(e.message ?? "");
}
function rate(e: NonNullable<AuthErrorLike>): boolean {
  return e.status === 429 || /rate_limit/.test(e.code ?? "") || /rate limit|too many/i.test(e.message ?? "");
}

/** Sending the code (signInWithOtp). */
export function sendCodeError(e: AuthErrorLike): string {
  if (!e) return AUTH_TEXT.sendFailed;
  if (offline(e)) return AUTH_TEXT.offline;
  if (rate(e)) return AUTH_TEXT.rate;
  if (typeof e.status === "number" && e.status >= 500) return AUTH_TEXT.sendFailed;   // e.g. the email could not be sent
  if (e.code === "email_address_invalid" || e.code === "validation_failed" || /invalid.*email|email.*invalid|valid email/i.test(e.message ?? "")) return AUTH_TEXT.badEmail;
  return AUTH_TEXT.sendFailed;
}

/** Checking the code (verifyOtp). Only a real refusal says the code is wrong. */
export function verifyCodeError(e: AuthErrorLike): string {
  if (!e) return AUTH_TEXT.wrongCode;
  if (offline(e)) return AUTH_TEXT.offline;
  if (rate(e)) return AUTH_TEXT.rate;
  if (typeof e.status === "number" && e.status >= 500) return AUTH_TEXT.server;
  return AUTH_TEXT.wrongCode;
}
