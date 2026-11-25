import "server-only";
import { bounded } from "@/lib/bounded";
import type { AppleToken, ExchangeResult, RevokeResult, VerifyResult } from "./revoke";

/**
 * E1: closing an account that has a Sign in with Apple identity, with token revocation. PREPARED, NOT WIRED (no route
 * calls this yet). Design approved 25 Nov (E1-a fresh Apple authentication, nothing stored; E1-b; E1-c), with the
 * review's corrections:
 *
 *  - The expected Apple user id comes ONLY from the authenticated account's server-side identity records (point 5).
 *    The input carries no identifier; anything else the client sends is ignored.
 *  - Recent authentication is never granted here (E1-b). The database's own rule decides (close_my_account refuses
 *    'reauth_required' unless the session's sign-in is within 10 minutes). For an Apple confirmation to count, the app
 *    signs in to Supabase again with the fresh Apple identity token (Supabase verifies it and issues a new session);
 *    this module only checks recency first, read-only, so Apple is not contacted for a request that would be refused.
 *  - Order (point 2; second review 25 Nov): verify the Apple identity → close (the existing rules, unchanged) →
 *    revoke AT ONCE → the existing deletion processing. The token exists only in this request, so the revocation is
 *    attempted before the processing, which can be slow or time out. Nothing is closed unless the Apple step
 *    succeeded; nothing is revoked unless the closure is confirmed; the deletion continues whatever the revocation does.
 *  - An ambiguous closure (second review): close_my_account may have committed even though its answer was lost (a
 *    timeout, a dropped connection, a thrown error). Then the account's deletion record decides: closed → continue
 *    (revoke, process); not closed → nothing changed, safely; still unknown → "close_result_unknown" and an alert,
 *    never "nothing changed", and no revocation (it is attempted only for a confirmed closure).
 *  - E1-c / point 3: once closed, a revocation failure never undoes or blocks the deletion; it raises an alert. When
 *    Apple cannot be used at all (cancelled, unavailable, misconfigured), the person can still delete with the
 *    existing email-code confirmation ("fallback"); the account is closed by the same database rules, revocation is
 *    recorded as skipped with an alert, and the app tells them how to remove CourtBook from their Apple ID settings.
 */

/** ok:false = a definite answer from the database (its refusal or error: nothing committed). A thrown error, a
 *  time-out or ok:"unknown" = the answer was lost; the closure may or may not have committed. */
export type CloseOutcome = { ok: true } | { ok: false; code: string } | { ok: "unknown" };

/** Closed states of an account_deletions record (0086). 'requested' (an old app's unconfirmed request) is not closed. */
export const CLOSED_STATES = ["closing", "closed", "held", "data_removed", "done"] as const;
/**
 * From the account's deletion records, read server-side (service key) by subject id. Third review, point 2: only a
 * SUCCESSFUL lookup can prove "open". `null`/`undefined` means the lookup failed and is "unknown"; an empty list (the
 * lookup worked and found no record) is "open".
 */
export function closureFromRecords(rows: { status?: unknown }[] | null | undefined): "closed" | "open" | "unknown" {
  if (!Array.isArray(rows)) return "unknown";
  return rows.some((r) => (CLOSED_STATES as readonly unknown[]).includes(r?.status)) ? "closed" : "open";
}

/** Upper limits for each awaited step (third review, point 3). Bookkeeping (alerts, markers) never waits long. */
export const LIMITS = { lookup: 5_000, apple: 10_000, close: 10_000, status: 5_000, revoke: 10_000, bookkeeping: 3_000 } as const;

export type AppleDeletionDeps = {
  /** The CourtBook account authenticated on THIS request (from its bearer token, checked with Supabase Auth). */
  userId: string;
  /** The account a deletion intent was issued to (intent.ts verifyIntent with the server secret); null: invalid/expired. */
  intentOwner: (intent: unknown) => string | null;
  /** Apple user ids on the signed-in account's identities (provider "apple"), read server-side. null: lookup failed. */
  appleSubs: (signal: AbortSignal) => Promise<string[] | null>;
  /** recently_authenticated() as the signed-in person (read-only). null: could not be read. */
  recentlyAuthenticated: (signal: AbortSignal) => Promise<boolean | null>;
  exchange: (code: string, signal: AbortSignal) => Promise<ExchangeResult>;
  verify: (idToken: string, signal: AbortSignal) => Promise<VerifyResult>;
  /** close_my_account as the signed-in person: every existing rule applies (recent sign-in, staff/admin, processing). */
  close: (signal: AbortSignal) => Promise<CloseOutcome>;
  /** After an ambiguous close: closureFromRecords() of the account's deletion records ("unknown" if the read failed). */
  closureStatus: (signal: AbortSignal) => Promise<"closed" | "open" | "unknown">;
  /** Marks the sign-in record with the revocation outcome, so the deletion processing does not alert again. Best effort. */
  markRevocation: (outcome: "done" | "failed" | "skipped", signal: AbortSignal) => Promise<void>;
  /** The existing deletion processing (B–E). It records its own failures; a throw here changes nothing below. */
  process: () => Promise<void>;
  revoke: (token: AppleToken, signal: AbortSignal) => Promise<RevokeResult>;
  alert: (event: "appleRevokeFailed" | "appleRevocationSkipped" | "appleIdentityRejected" | "appleCloseResultUnknown",
          code: string, signal: AbortSignal) => Promise<void>;
};

/** What the app sends. Deliberately no Apple user id (the expected identity is never client-supplied); the intent
 *  was issued to the ORIGINAL account before the Apple sheet (intent.ts). */
export type AppleDeletionInput = { method: "apple"; code: string; intent: string } | { method: "fallback"; intent: string };

export type AppleDeletionResult =
  | { closed: true; revocation: "done" | "failed" | "skipped" }
  | { closed: false; code: string }                            // definite: nothing changed
  | { closed: "unknown"; code: "close_result_unknown" };       // the closure may have happened: never "nothing changed"

export async function closeAppleAccount(input: AppleDeletionInput, deps: AppleDeletionDeps): Promise<AppleDeletionResult> {
  const method = input?.method === "apple" ? "apple" : input?.method === "fallback" ? "fallback" : null;
  if (!method) return { closed: false, code: "bad_request" };
  const note = (event: Parameters<AppleDeletionDeps["alert"]>[0], code: string) => bounded(LIMITS.bookkeeping, (s) => deps.alert(event, code, s));

  // third review, point 1: the deletion must belong to the account that asked for it BEFORE the Apple sheet. If the
  // Apple reauthentication led to another CourtBook account, this request is authenticated as that other account.
  const owner = deps.intentOwner(input.intent);
  if (!owner) return { closed: false, code: "intent_invalid" };
  if (owner !== deps.userId) return { closed: false, code: "account_mismatch" };

  const subsR = await bounded(LIMITS.lookup, (s) => deps.appleSubs(s));
  const subs = subsR.done ? subsR.value : null;
  if (subs === null) return { closed: false, code: "identity_lookup_failed" };
  if (subs.length === 0) return { closed: false, code: "not_apple_account" };   // the ordinary deletion applies

  const recentR = await bounded(LIMITS.lookup, (s) => deps.recentlyAuthenticated(s));
  const recent = recentR.done ? recentR.value : null;
  if (recent === null) return { closed: false, code: "failed" };
  if (!recent) return { closed: false, code: "reauth_required" };

  let token: AppleToken | null = null;
  if (method === "apple") {
    const code = (input as { code?: unknown }).code;
    if (typeof code !== "string" || !code) return { closed: false, code: "apple_code_missing" };
    const exR = await bounded(LIMITS.apple, (s) => deps.exchange(code, s));
    const ex: ExchangeResult = exR.done ? exR.value : { ok: false, code: "apple_unavailable" };
    if (!ex.ok) return { closed: false, code: ex.code === "code_rejected" ? "apple_code_rejected" : "apple_unavailable" };
    const vR = await bounded(LIMITS.apple, (s) => deps.verify(ex.idToken, s));
    const v: VerifyResult = vR.done ? vR.value : { ok: false, code: "apple_unavailable" };
    if (!v.ok) {
      if (v.code === "apple_unavailable") return { closed: false, code: "apple_unavailable" };
      await note("appleIdentityRejected", v.code);
      return { closed: false, code: "apple_identity_unverified" };
    }
    if (!subs.includes(v.sub)) return { closed: false, code: "wrong_apple_account" };
    token = ex.token;
  }

  // the database decides; nothing about Apple can override its refusals
  const closeR = await bounded(LIMITS.close, (s) => deps.close(s));
  const closed: CloseOutcome = closeR.done ? closeR.value : { ok: "unknown" };   // thrown or timed out: answer lost
  if (closed.ok === false) return { closed: false, code: closed.code };          // a definite refusal: nothing revoked
  if (closed.ok === "unknown") {
    const stR = await bounded(LIMITS.status, (s) => deps.closureStatus(s));
    const now = stR.done ? stR.value : "unknown";
    if (now === "open") return { closed: false, code: "failed" };                // a successful read: not closed
    if (now !== "closed") {
      await note("appleCloseResultUnknown", method);
      return { closed: "unknown", code: "close_result_unknown" };
    }
  }

  // closed from here on, whatever happens next. Revoke first: the token lives only in this request.
  let revocation: "done" | "failed" | "skipped";
  if (!token) {
    revocation = "skipped";
    await note("appleRevocationSkipped", "fallback");
  } else {
    const t = token;
    const rR = await bounded(LIMITS.revoke, (s) => deps.revoke(t, s));
    const r: RevokeResult = rR.done ? rR.value : { ok: false, code: "apple_unavailable" };
    revocation = r.ok ? "done" : "failed";
    if (!r.ok) await note("appleRevokeFailed", r.code);
  }
  await bounded(LIMITS.bookkeeping, (s) => deps.markRevocation(revocation, s));
  await deps.process().catch(() => undefined);
  return { closed: true, revocation };
}

type Identity = { provider?: unknown; provider_id?: unknown; identity_data?: { sub?: unknown } | null };
/**
 * The Apple user ids of an account, from the user record Supabase's admin API returns for the AUTHENTICATED user id
 * (auth.admin.getUserById, server-side, service key). An account may have several sign-in methods (email and Apple);
 * only "apple" identities count. Never fed from the request body.
 */
export function appleSubsFromUser(user: { identities?: Identity[] | null } | null | undefined): string[] {
  const out = new Set<string>();
  for (const i of user?.identities ?? []) {
    if (i?.provider !== "apple") continue;
    const sub = typeof i.identity_data?.sub === "string" && i.identity_data.sub ? i.identity_data.sub
      : typeof i.provider_id === "string" && i.provider_id ? i.provider_id : null;
    if (sub) out.add(sub);
  }
  return [...out];
}

/** The app_metadata key on the sign-in record holding the revocation outcome (it disappears with the record at D). */
export const REVOCATION_MARK = "apple_revocation";

/** For the deletion processing's check before D (pipeline AppleRevocationHook.state). */
export function appleLinkState(user: { identities?: Identity[] | null; app_metadata?: Record<string, unknown> | null } | null | undefined):
  { apple: boolean; marked: boolean } {
  return { apple: appleSubsFromUser(user).length > 0, marked: typeof user?.app_metadata?.[REVOCATION_MARK] === "string" };
}
