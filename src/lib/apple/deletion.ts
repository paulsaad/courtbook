import "server-only";
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
 *  - Order (point 2): verify the Apple identity → close (the existing rules, unchanged) → the existing deletion
 *    processing → revoke. Nothing is closed unless the Apple step succeeded; nothing is revoked unless the account
 *    was closed.
 *  - E1-c / point 3: once closed, a revocation failure never undoes or blocks the deletion; it raises an alert. When
 *    Apple cannot be used at all (cancelled, unavailable, misconfigured), the person can still delete with the
 *    existing email-code confirmation ("fallback"); the account is closed by the same database rules, revocation is
 *    recorded as skipped with an alert, and the app tells them how to remove CourtBook from their Apple ID settings.
 */

export type CloseOutcome = { ok: true } | { ok: false; code: string };

export type AppleDeletionDeps = {
  /** Apple user ids on the signed-in account's identities (provider "apple"), read server-side. null: lookup failed. */
  appleSubs: () => Promise<string[] | null>;
  /** recently_authenticated() as the signed-in person (read-only). null: could not be read. */
  recentlyAuthenticated: () => Promise<boolean | null>;
  exchange: (code: string) => Promise<ExchangeResult>;
  verify: (idToken: string) => Promise<VerifyResult>;
  /** close_my_account as the signed-in person: every existing rule applies (recent sign-in, staff/admin, processing). */
  close: () => Promise<CloseOutcome>;
  /** The existing deletion processing (B–E). It records its own failures; a throw here changes nothing below. */
  process: () => Promise<void>;
  revoke: (token: AppleToken) => Promise<RevokeResult>;
  alert: (event: "appleRevokeFailed" | "appleRevocationSkipped" | "appleIdentityRejected", code: string) => Promise<void>;
};

/** What the app sends. Deliberately no Apple user id: the expected identity is never client-supplied. */
export type AppleDeletionInput = { method: "apple"; code: string } | { method: "fallback" };

export type AppleDeletionResult =
  | { closed: true; revocation: "done" | "failed" | "skipped" }
  | { closed: false; code: string };

export async function closeAppleAccount(input: AppleDeletionInput, deps: AppleDeletionDeps): Promise<AppleDeletionResult> {
  const method = input?.method === "apple" ? "apple" : input?.method === "fallback" ? "fallback" : null;
  if (!method) return { closed: false, code: "bad_request" };

  const subs = await deps.appleSubs().catch(() => null);
  if (subs === null) return { closed: false, code: "identity_lookup_failed" };
  if (subs.length === 0) return { closed: false, code: "not_apple_account" };   // the ordinary deletion applies

  const recent = await deps.recentlyAuthenticated().catch(() => null);
  if (recent === null) return { closed: false, code: "failed" };
  if (!recent) return { closed: false, code: "reauth_required" };

  let token: AppleToken | null = null;
  if (method === "apple") {
    const code = (input as { code?: unknown }).code;
    if (typeof code !== "string" || !code) return { closed: false, code: "apple_code_missing" };
    const ex = await deps.exchange(code).catch((): ExchangeResult => ({ ok: false, code: "apple_unavailable" }));
    if (!ex.ok) return { closed: false, code: ex.code === "code_rejected" ? "apple_code_rejected" : "apple_unavailable" };
    const v = await deps.verify(ex.idToken).catch((): VerifyResult => ({ ok: false, code: "apple_unavailable" }));
    if (!v.ok) {
      if (v.code === "apple_unavailable") return { closed: false, code: "apple_unavailable" };
      await deps.alert("appleIdentityRejected", v.code).catch(() => undefined);
      return { closed: false, code: "apple_identity_unverified" };
    }
    if (!subs.includes(v.sub)) return { closed: false, code: "wrong_apple_account" };
    token = ex.token;
  }

  // the database decides; nothing about Apple can override its refusals
  const closed = await deps.close().catch((): CloseOutcome => ({ ok: false, code: "failed" }));
  if (!closed.ok) return { closed: false, code: closed.code };   // not closed → nothing revoked (the token is dropped)

  // closed from here on, whatever happens next
  await deps.process().catch(() => undefined);

  if (!token) {
    await deps.alert("appleRevocationSkipped", "fallback").catch(() => undefined);
    return { closed: true, revocation: "skipped" };
  }
  const r = await deps.revoke(token).catch((): RevokeResult => ({ ok: false, code: "apple_unavailable" }));
  if (r.ok) return { closed: true, revocation: "done" };
  await deps.alert("appleRevokeFailed", r.code).catch(() => undefined);
  return { closed: true, revocation: "failed" };
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
