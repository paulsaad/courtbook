/**
 * E1 (draft, OFF by default): deleting an account that signs in with Apple, from the iOS app, with Sign in with Apple
 * token revocation on the server (website route /api/account/apple-delete; src/lib/apple/deletion.ts has the rules).
 *
 * Third review 25 Nov, point 1 — no account switching during the Apple step:
 *  1. Before the Apple sheet, the app records the ORIGINAL account (its signed-in user id) and asks the server for a
 *     deletion intent with the ORIGINAL session. The server binds the intent to that account.
 *  2. The Apple sheet returns an identity token and a one-time authorization code. The identity token is handed to
 *     Supabase on a SEPARATE, in-memory client (never stored, never replacing the app's own session), with the raw
 *     nonce whose SHA-256 was given to Apple. That is a real Supabase sign-in, so the database's existing 10-minute
 *     recent-sign-in rule is met by Supabase itself (E1-b), not by anything this app or the server asserts.
 *  3. If that sign-in is for any other CourtBook account, the app stops: it signs the in-memory session out, calls
 *     nothing else and leaves the app's own session untouched. The server would refuse anyway (intent ≠ account).
 *  4. Otherwise the code and the intent go to the server with the fresh session.
 * Apple cancelled or unavailable → the fallback: the existing email code on the app's own session, then the same
 * server call with method "fallback". A lost answer is never shown as "nothing changed": the app reads its own
 * deletion status first (as closeMyAccount does).
 *
 * Everything here is injected (AppleDeletionDeps) so the handoff can be tested without Apple or Supabase.
 */
import { PROCESSING_PAUSED, CLOSE_MESSAGES } from "./accountClosing";

export type Session = { userId: string; accessToken: string };
export type ApiAnswer = { status: number; body: unknown } | null;   // null: no answer (network)

export type AppleDeletionDeps = {
  /** The app's own signed-in session (the ORIGINAL account). */
  mainSession: () => Promise<Session | null>;
  /** POST to the CourtBook website with a bearer token. */
  post: (path: "/api/account/apple-delete/intent" | "/api/account/apple-delete", token: string, body?: Record<string, string>) => Promise<ApiAnswer>;
  /** A fresh random nonce and its SHA-256 (hex), as Supabase expects for Apple. */
  nonce: () => Promise<{ raw: string; hashed: string }>;
  /** The native Apple sheet, given the HASHED nonce. */
  appleSheet: (hashedNonce: string) => Promise<{ identityToken: string; authorizationCode: string } | "cancelled" | "unavailable">;
  /** Supabase sign-in with the Apple identity token on an in-memory client (raw nonce). null: refused. */
  freshSignIn: (identityToken: string, rawNonce: string) => Promise<(Session & { signOut: () => Promise<void> }) | null>;
  /** The app's own deletion status (my_account_deletion): true closed, false open, null unreadable. */
  closedNow: () => Promise<boolean | null>;
  /** Sign the app out everywhere (as after any deletion). */
  signOutEverywhere: () => Promise<void>;
};

export type AppleDeletionOutcome =
  | { kind: "closed"; revocation: "done" | "failed" | "skipped" }
  | { kind: "use_fallback"; intent: string; reason: "cancelled" | "apple_unavailable" }   // offer the email code
  | { kind: "not_configured" }                                                            // use the existing flow
  | { kind: "account_mismatch" }
  | { kind: "unknown" }                                                                   // may have closed: say so
  | { kind: "refused"; message: string };

export const MISMATCH_TEXT =
  "That Apple ID belongs to a different CourtBook account, so nothing was deleted. Try again with the Apple ID you use for this account.";
export const UNKNOWN_TEXT =
  "We couldn't confirm whether your account was deleted. Please check your connection and open Profile again before trying anything else.";
export const APPLE_FAILED_TEXT = "That didn't work, and nothing was changed. Please try again, or confirm with an email code instead.";
export const REVOCATION_NOTE =
  "To also remove CourtBook from your Apple ID, open Settings → your name → Sign in with Apple → CourtBook → Stop Using Apple ID.";
const FAILED = "That didn't work, and nothing was changed. Please try again.";

const intentOf = (a: ApiAnswer) => (a && a.status === 200 && typeof (a.body as { intent?: unknown })?.intent === "string" ? (a.body as { intent: string }).intent : null);

/** Step 1: the intent, with the ORIGINAL session. */
export async function startAppleDeletion(d: AppleDeletionDeps): Promise<{ intent: string; original: Session } | AppleDeletionOutcome> {
  const original = await d.mainSession();
  if (!original) return { kind: "refused", message: FAILED };
  const a = await d.post("/api/account/apple-delete/intent", original.accessToken);
  if (a?.status === 503) return { kind: "not_configured" };
  const intent = intentOf(a);
  return intent ? { intent, original } : { kind: "refused", message: FAILED };
}

/** The whole Apple path. */
export async function deleteWithApple(d: AppleDeletionDeps): Promise<AppleDeletionOutcome> {
  const start = await startAppleDeletion(d);
  if ("kind" in start) return start;
  const { intent, original } = start;

  const n = await d.nonce();
  const sheet = await d.appleSheet(n.hashed);
  if (sheet === "cancelled") return { kind: "use_fallback", intent, reason: "cancelled" };
  if (sheet === "unavailable") return { kind: "use_fallback", intent, reason: "apple_unavailable" };

  const fresh = await d.freshSignIn(sheet.identityToken, n.raw);
  if (!fresh) return { kind: "use_fallback", intent, reason: "apple_unavailable" };
  if (fresh.userId !== original.userId) {
    // a different CourtBook account: stop here; the app's own session (the original account) is untouched
    await fresh.signOut().catch(() => undefined);
    return { kind: "account_mismatch" };
  }
  const answer = await d.post("/api/account/apple-delete", fresh.accessToken, { method: "apple", code: sheet.authorizationCode, intent });
  const out = await settle(d, answer);
  if (out.kind !== "closed") await fresh.signOut().catch(() => undefined);
  return out;
}

/** The fallback, after the existing email code was verified on the app's own session (a recent sign-in). */
export async function deleteWithFallback(d: AppleDeletionDeps, intent: string): Promise<AppleDeletionOutcome> {
  const s = await d.mainSession();
  if (!s) return { kind: "refused", message: FAILED };
  return settle(d, await d.post("/api/account/apple-delete", s.accessToken, { method: "fallback", intent }));
}

async function settle(d: AppleDeletionDeps, a: ApiAnswer): Promise<AppleDeletionOutcome> {
  const body = (a?.body ?? {}) as { closed?: unknown; revocation?: unknown; error?: unknown };
  if (a && a.status === 200 && body.closed === true) {
    await d.signOutEverywhere().catch(() => undefined);
    const r = body.revocation === "done" || body.revocation === "failed" || body.revocation === "skipped" ? body.revocation : "failed";
    return { kind: "closed", revocation: r };
  }
  if (a && a.status !== 202 && body.closed === false) {
    const code = typeof body.error === "string" ? body.error : "";
    if (code === "account_mismatch") return { kind: "account_mismatch" };
    if (code === "processing_unavailable") return { kind: "refused", message: PROCESSING_PAUSED };
    if (CLOSE_MESSAGES[code]) return { kind: "refused", message: CLOSE_MESSAGES[code] };
    if (code.startsWith("apple_") || code === "wrong_apple_account") return { kind: "refused", message: code === "wrong_apple_account" ? MISMATCH_TEXT : APPLE_FAILED_TEXT };
    return { kind: "refused", message: FAILED };
  }
  // no answer, an unreadable answer, or the server's own "unknown" (202): the account may be closed. Ask the database.
  const closed = await d.closedNow().catch(() => null);
  if (closed === true) { await d.signOutEverywhere().catch(() => undefined); return { kind: "closed", revocation: "failed" }; }
  // not confirmed closed: still "unknown" (a lost request may yet commit), never "nothing changed"
  return { kind: "unknown" };
}

/** On only with EXPO_PUBLIC_APPLE_DELETION=1, on iOS, for an account with an Apple identity. Off: the existing flow. */
export function appleDeletionOn(flag: string | undefined, os: string, user: { identities?: { provider?: string }[] | null } | null | undefined): boolean {
  return flag === "1" && os === "ios" && !!user?.identities?.some((i) => i.provider === "apple");
}
