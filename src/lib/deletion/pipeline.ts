/**
 * M2 (0086): processes one closed account, B → E, after close_my_account (A) has committed. The same function runs
 * inline after a website close, from the retry route and from the admin Retry/Release buttons.
 *
 *   claim      lease the record (5 min, token); another run holding it → stop, do nothing
 *   B  ban     sign-in banned (no new sign-in, no refresh); record 'banned'
 *   held       cancel-only data step once, then 'released' and stop: the rest waits for an admin Release
 *   C  data    delete_account_data, ALWAYS, even if an earlier run did it: a booking statement that began before the
 *              close committed can land just after it, and C is what cancels it. C touches only what is left.
 *   D  auth    delete the sign-in (profile goes with it). "Not found" = an earlier run got here.
 *   E  finish  finish_account_deletion → done (idempotent; clears the lease)
 *
 * Any failure: record 'failed' with a code (backoff, next try later) and stop. Every step is safe to repeat, so a run
 * that dies anywhere leaves a state the next run continues from. Before each long step (cancel-only, C, D, E) the run
 * renews its lease, which also checks it still holds the record: a slow run whose lease expired and was taken over
 * stops there ('lease_lost') instead of carrying on beside the new run (review 23 Nov, finding 5; even if it did carry
 * on, every step is idempotent: supabase/tests/m86/pipeline_e2e.mjs E9). Nothing about the person is returned or
 * logged: codes only.
 *
 * Server only. `rpc` must be the SERVICE client (claim/record refuse any signed-in caller).
 */

import { bounded } from "@/lib/bounded";

export type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
export type AuthResult = { error: { message?: string; status?: number; code?: string } | null };
export type DeletionDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  banUser: (id: string) => PromiseLike<AuthResult>;
  deleteUser: (id: string) => PromiseLike<AuthResult>;
  /** E1: before D removes the sign-in, notice an Apple-linked account whose Apple tokens were not revoked (an older
   *  app closed it directly) and raise `appleRevocationSkipped`. Never blocks D. In serviceDeps only when E1 is
   *  configured (routeDeps.appleRevocationHook); today it is not. */
  appleRevocation?: AppleRevocationHook;
};

export type AppleRevocationHook = {
  /** The sign-in's Apple link and whether a revocation outcome is already recorded on it. null: could not read. */
  state: (id: string, signal: AbortSignal) => Promise<{ apple: boolean; marked: boolean } | null>;
  alert: (code: string, signal: AbortSignal) => Promise<void>;
  /** Records that the skip was alerted, so a later run does not alert again. Must THROW when the write was not
   *  confirmed: the failure is then alerted ("mark_failed") instead of being taken as recorded (fourth review). */
  mark: (id: string, signal: AbortSignal) => Promise<void>;
};
/** The whole Apple check may take at most this long; then D goes ahead (review 25 Nov: never delay deletion). On the
 *  limit the check is aborted: a slow answer that arrives later starts nothing (no alert, no mark), so no work of it
 *  continues once the sign-in record is deleted (third review, point 3). */
export const APPLE_CHECK_MS = 3_000;

async function noteAppleRevocation(subject: string, hook: AppleRevocationHook, ms = APPLE_CHECK_MS): Promise<void> {
  await bounded(ms, async (signal) => {
    const st = await hook.state(subject, signal);
    if (signal.aborted || !st || !st.apple || st.marked) return;
    await hook.alert("old_app_or_direct_close", signal);
    if (signal.aborted) return;
    try {
      await hook.mark(subject, signal);
    } catch {
      // not recorded: say so (a later run may alert again for this account, a duplicate rather than a silent gap)
      if (!signal.aborted) await hook.alert("mark_failed", signal).catch(() => undefined);
    }
  });
}

export type Outcome =
  | { result: "done" }
  | { result: "held"; reason: string | null }
  | { result: "skipped"; reason: string }          // busy, leased, held (nothing to do), done, cancelled, none
  | { result: "failed"; step: Step; code: string }
  | { result: "lease_lost"; step: Step };
type Step = "claim" | "ban" | "cancel_only" | "data" | "auth_delete" | "finish" | "record";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z_]{1,40}$/;

/** A database refusal is a bare code ("staff_role", "lease_lost") or "held: legal_hold"; anything else is "failed". */
export function dbCode(err: { message?: string } | null | undefined): string {
  const m = (err?.message ?? "").trim();
  if (CODE.test(m)) return m;
  const held = /^held: ([a-z_]{1,30})$/.exec(m);
  return held ? `held_${held[1]}` : "failed";
}
const errorCode = (step: string, code: string) => `${step}_${code}`.slice(0, 60);
/** Only Supabase Auth's own answer that the sign-in does not exist: HTTP 404 and code user_not_found (or, from
 *  versions without codes, the message "User not found"). Any other 404 — a wrong URL, a proxy — is a failure. */
const notFound = (e: { message?: string; status?: number; code?: string }) =>
  e.status === 404 && (e.code === "user_not_found" || (!e.code && /^user not found$/i.test((e.message ?? "").trim())));

type Claim = { claimed: true; token: string; status: string; held_reason: string | null; banned: boolean; cancellations_done: boolean }
  | { claimed: false; reason: string };

export async function processDeletion(subject: string, deps: DeletionDeps): Promise<Outcome> {
  if (!UUID.test(subject)) return { result: "skipped", reason: "none" };

  const c = await deps.rpc("claim_deletion", { p_subject: subject, p_lease_seconds: 300 });
  if (c.error) return { result: "failed", step: "claim", code: dbCode(c.error) };
  const claim = c.data as Claim;
  if (!claim?.claimed) return { result: "skipped", reason: (claim as { reason?: string })?.reason ?? "none" };
  const token = claim.token;

  /** Bookkeeping; false = this run no longer holds the record and must stop. */
  async function record(step: "banned" | "failed" | "released" | "renew", error?: string): Promise<boolean | "error"> {
    const r = await deps.rpc("record_deletion_step", { p_subject: subject, p_token: token, p_step: step, p_error: error ?? null });
    if (!r.error) return true;
    return dbCode(r.error) === "lease_lost" ? false : "error";
  }
  /** Still mine? Keep it mine for another lease. null = carry on. */
  async function renew(step: Step): Promise<Outcome | null> {
    const r = await record("renew");
    if (r === false) return { result: "lease_lost", step };
    if (r === "error") return { result: "failed", step: "record", code: "failed" };
    return null;
  }
  async function fail(step: Step, code: string): Promise<Outcome> {
    const r = await record("failed", errorCode(step, code));
    if (r === false) return { result: "lease_lost", step };
    return { result: "failed", step, code };   // if even the bookkeeping failed, the lease expires and a later run retries
  }

  try {
    // B: ban (closing; or held and not yet banned)
    if (!claim.banned) {
      const b = await deps.banUser(subject);
      if (b.error && !notFound(b.error)) return await fail("ban", "failed");
      const r = await record("banned");
      if (r === false) return { result: "lease_lost", step: "ban" };
      if (r === "error") return { result: "failed", step: "record", code: "failed" };
    }

    // held: the cancellations once, then wait for an admin
    if (claim.status === "held") {
      if (!claim.cancellations_done) {
        const stop = await renew("cancel_only"); if (stop) return stop;
        const x = await deps.rpc("delete_account_data", { p_subject: subject, p_cancel_only: true });
        if (x.error) return await fail("cancel_only", dbCode(x.error));
      }
      const r = await record("released");
      if (r === false) return { result: "lease_lost", step: "cancel_only" };
      return { result: "held", reason: claim.held_reason };
    }

    // C: always (see header)
    let stop = await renew("data"); if (stop) return stop;
    const data = await deps.rpc("delete_account_data", { p_subject: subject, p_cancel_only: false });
    if (data.error) return await fail("data", dbCode(data.error));

    // D (first, E1: notice an Apple link that was never revoked, while the sign-in record still exists; never blocks)
    stop = await renew("auth_delete"); if (stop) return stop;
    if (deps.appleRevocation) await noteAppleRevocation(subject, deps.appleRevocation);
    const del = await deps.deleteUser(subject);
    if (del.error && !notFound(del.error)) return await fail("auth_delete", "failed");

    // E
    stop = await renew("finish"); if (stop) return stop;
    const fin = await deps.rpc("finish_account_deletion", { p_subject: subject });
    if (fin.error) return await fail("finish", dbCode(fin.error));
    return { result: "done" };
  } catch {
    // a thrown network error: unknown step outcome; every step is repeatable, so record and let a later run continue
    return await fail("record", "exception").catch(() => ({ result: "failed", step: "record", code: "exception" }) as Outcome);
  }
}

/** The service-role dependencies (server only; imported lazily so this module stays testable without env). */
export async function serviceDeps(): Promise<DeletionDeps> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  // every call gives up after 15 s, so a hung call cannot outlive the route (the lease covers the rest)
  const admin = createAdminClient({ timeoutMs: 15_000 });
  return {
    rpc: (fn, args) => admin.rpc(fn, args),
    // ~100 years: Supabase's ban is a duration; the sign-in is deleted at D anyway
    banUser: (id) => admin.auth.admin.updateUserById(id, { ban_duration: "876000h" }),
    deleteUser: (id) => admin.auth.admin.deleteUser(id),
    // E1 older-app check before D: undefined (off) unless Sign in with Apple deletion is configured. Loading it can
    // never stop the deletion: any failure means no check.
    appleRevocation: await import("@/lib/apple/routeDeps").then((m) => m.appleRevocationHook()).catch(() => undefined),
  };
}
