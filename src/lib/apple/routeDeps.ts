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

/** A database answer for close_my_account. Only an answer that carries a database or API error code is DEFINITE
 *  (nothing committed); anything else — a network failure, an abort, a gateway error without a code — is "unknown". */
export function closeOutcomeOf(r: { error: { message?: string; code?: string } | null } | null | undefined): CloseOutcome {
  if (!r) return { ok: "unknown" };
  if (!r.error) return { ok: true };
  return typeof r.error.code === "string" && r.error.code ? { ok: false, code: dbCode(r.error) } : { ok: "unknown" };
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
      await admin.auth.admin.updateUserById(who.userId, { app_metadata: { [REVOCATION_MARK]: outcome } });
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
    mark: async (id) => { await admin.auth.admin.updateUserById(id, { app_metadata: { [REVOCATION_MARK]: "skipped" } }); },
  };
}
