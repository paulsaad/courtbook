import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BearerPlayer } from "@/lib/supabase/bearer";
import { processDeletion, serviceDeps, dbCode, type AppleRevocationHook } from "@/lib/deletion/pipeline";
import { report } from "@/lib/report";
import { AppleKeys, appleConfig, exchangeCode, revokeToken, verifyAppleIdToken, type AppleConfig } from "./revoke";
import { REVOCATION_MARK, appleLinkState, appleSubsFromUser, closureFromRecords, type AppleDeletionDeps, type CloseOutcome } from "./deletion";
import { intentSecret, verifyIntent } from "./intent";

/**
 * E1 route wiring (draft): the real dependencies of closeAppleAccount, and of the deletion processing's older-app
 * check. Everything is OFF unless BOTH the company's Sign in with Apple credentials (APPLE_*) and DELETION_INTENT_SECRET
 * are configured; neither is configured anywhere today.
 */
export type AppleDeletionSetup = { cfg: AppleConfig; secret: string };

export function appleDeletionSetup(env: Record<string, string | undefined> = process.env): AppleDeletionSetup | null {
  const cfg = appleConfig(env), secret = intentSecret(env);
  return cfg && secret ? { cfg, secret } : null;
}

// Apple's signing keys, shared by requests on the same server instance (cached one hour inside AppleKeys)
let keys: AppleKeys | null = null;
const appleKeys = () => (keys ??= new AppleKeys());
/** Tests only: forget the cached keys (a cached key set otherwise survives a later outage of Apple's key endpoint). */
export function resetAppleKeysForTests(): void { keys = null; }

/**
 * close_my_account's answer → definite or unknown (fourth review 25 Nov).
 *
 * DEFINITE (nothing committed) only when Postgres itself refused the statement and PostgREST passed that refusal back
 * as a client error: an SQLSTATE in a class where the statement is rolled back by the database's own decision —
 *   P0 (our raise exception: reauth_required, staff_role, …), 22 (data), 23 (integrity), 28 (authorization),
 *   40 (serialization failure / deadlock: rolled back), 42 (privilege / syntax) —
 * with an HTTP 4xx status (or no status at all, as in tests).
 * Everything else is UNKNOWN and goes to the closure-status recovery: PostgREST's own codes (PGRST…: connection,
 * pool and schema-cache errors, time-outs), gateway and transport failures (no code, 5xx, status 0), query
 * cancellation or shutdown (57…), connection exceptions (08…), resource or internal errors (53, 58, XX), any 5xx.
 */
const DEFINITE_CLASSES = new Set(["P0", "22", "23", "28", "40", "42"]);
const SQLSTATE = /^[0-9A-Z]{5}$/;

export function closeOutcomeOf(
  r: { error: { message?: string; code?: string } | null; status?: number } | null | undefined,
): CloseOutcome {
  if (!r) return { ok: "unknown" };
  if (!r.error) return { ok: true };
  const code = typeof r.error.code === "string" ? r.error.code : "";
  const status = typeof r.status === "number" ? r.status : null;
  const clientError = status === null || (status >= 400 && status < 500);
  if (SQLSTATE.test(code) && !code.startsWith("PGRST") && DEFINITE_CLASSES.has(code.slice(0, 2)) && clientError) {
    return { ok: false, code: dbCode(r.error) };
  }
  return { ok: "unknown" };
}

export function appleDeletionDeps(setup: AppleDeletionSetup, who: BearerPlayer, now: () => Date = () => new Date()): AppleDeletionDeps {
  const admin = createAdminClient({ timeoutMs: 10_000 });
  return {
    userId: who.userId,
    intentOwner: (intent) => { const v = verifyIntent(setup.secret, intent, now()); return v.ok ? v.userId : null; },
    appleSubs: async () => {
      const { data, error } = await admin.auth.admin.getUserById(who.userId);
      return error || !data?.user ? null : appleSubsFromUser(data.user);
    },
    recentlyAuthenticated: async (signal) => {
      const { data, error } = await who.player.rpc("recently_authenticated").abortSignal(signal);
      return error || typeof data !== "boolean" ? null : data;
    },
    exchange: (code, signal) => exchangeCode(setup.cfg, code, { signal }),
    verify: (idToken) => verifyAppleIdToken(idToken, { clientId: setup.cfg.clientId, keys: appleKeys(), now: now() }),
    close: async (signal) => closeOutcomeOf(await who.player.rpc("close_my_account", { p_via: "app" }).abortSignal(signal)),
    closureStatus: async (signal) => {
      const { data, error } = await admin.from("account_deletions").select("status").eq("subject_id", who.userId).abortSignal(signal);
      return closureFromRecords(error ? null : data);
    },
    markRevocation: async (outcome) => {
      // confirmed only by Auth's own answer showing the value; anything else throws (alerted by closeAppleAccount)
      const { data, error } = await admin.auth.admin.updateUserById(who.userId, { app_metadata: { [REVOCATION_MARK]: outcome } });
      if (error || data?.user?.app_metadata?.[REVOCATION_MARK] !== outcome) throw new Error("revocation_mark_not_confirmed");
    },
    process: async () => {
      const out = await processDeletion(who.userId, await serviceDeps());
      if (out.result === "failed") await report("deletionStepFailed", "account", { code: out.code });
    },
    revoke: (token, signal) => revokeToken(setup.cfg, token, { signal }),
    alert: (event, code) => report(event, "account", { code }),
  };
}

/** The deletion processing's older-app check (pipeline hook): only when E1 is configured. */
export function appleRevocationHook(env: Record<string, string | undefined> = process.env): AppleRevocationHook | undefined {
  if (!appleDeletionSetup(env)) return undefined;
  const admin = createAdminClient({ timeoutMs: 3_000 });
  return {
    state: async (id) => {
      const { data, error } = await admin.auth.admin.getUserById(id);
      return error || !data?.user ? null : appleLinkState(data.user);
    },
    alert: (code) => report("appleRevocationSkipped", "account", { code }),
    mark: async (id) => {
      const { data, error } = await admin.auth.admin.updateUserById(id, { app_metadata: { [REVOCATION_MARK]: "skipped" } });
      if (error || data?.user?.app_metadata?.[REVOCATION_MARK] !== "skipped") throw new Error("revocation_mark_not_confirmed");
    },
  };
}
