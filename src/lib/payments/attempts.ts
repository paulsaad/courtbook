import "server-only";
import type { PaymentProvider } from "./provider";

/**
 * Provider-independent handling of payment attempts (M12.1, 0094). Three callers share it, so they cannot disagree:
 * the provider's callback, the player's return page and the sweeper/reconciliation. Each one only ASKS the provider
 * (attemptStatus) and hands the answer to record_attempt_result, which is idempotent: asking twice, or from two places
 * at once, records a charge once.
 *
 * Nothing here logs or returns identifiers or database text: answers are fixed codes.
 */

/** The parts of a supabase-js client these functions use (the service-role client in production; a fake in tests). */
export type Rpc = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
};

/** Database refusals a caller may see by name. Anything else is reported as a fixed code, never as its text. */
export const PAYMENT_CODES = new Set([
  "not_authenticated", "not_found", "token_required", "wrong_payment_mode", "not_payable", "hold_expired", "attempts_exhausted",
  "attempt_not_found", "evidence_incomplete", "attempt_evidence_conflict", "duplicate_provider_ref", "charge_evidence_conflict",
  "bad_result", "bad_provider", "use_payment_attempts", "payments_not_configured",
  "account_closed",   // 0097: a closing or closed account starts no new payment
]);

/** The database's refusal as a known code, or `fallback`. The raw message never leaves the server. */
export function paymentCode(error: { message?: string } | null | undefined, fallback: string): string {
  const m = error?.message?.trim() ?? "";
  return PAYMENT_CODES.has(m) ? m : fallback;
}

/**
 * How long a provider may say it has never heard of an attempt before we stop treating that as "not yet" (M12.2).
 * After it, the attempt is recorded as expired. This is LONGER than the 10-minute hold: an attempt the provider never
 * received keeps its own hold from taking another attempt, so that player cannot pay again on that hold; the hold
 * ends at its own deadline as usual, the slot is free, and a new hold gets its own attempts at once
 * (supabase/tests/api/gateway.mjs G3). Not shortened without the provider's verified behaviour. Safe because money is
 * never inferred from silence: if a charge for that reference ever appears (status or the provider's charge list),
 * record_attempt_result still records it — a success after "expired" is recorded and, the hold being gone, owed back.
 */
export const UNKNOWN_GRACE_MINUTES = 30;

export type Recorded =
  | { ok: true; outcome: string }
  | { ok: false; code: "provider_unavailable" | "payment_record_failed" | string };

/** Ask the provider about one attempt, then record what it says. `createdAt`: when the attempt was made, so that a
 *  provider that has never heard of it can be believed after UNKNOWN_GRACE_MINUTES (without it, "unknown" = pending). */
export async function verifyAndRecord(admin: Rpc, provider: PaymentProvider, attemptId: string,
  opts: { createdAt?: string | Date | null; now?: Date } = {}): Promise<Recorded> {
  let status;
  try { status = await provider.attemptStatus(attemptId); } catch { return { ok: false, code: "provider_unavailable" }; }
  if (status.state === "unknown") {
    const made = opts.createdAt ? new Date(opts.createdAt).getTime() : NaN;
    const old = Number.isFinite(made) && (opts.now ?? new Date()).getTime() - made > UNKNOWN_GRACE_MINUTES * 60_000;
    status = { state: old ? "expired" : "pending" } as const;
  }
  const args = status.state === "succeeded"
    ? { p_attempt: attemptId, p_result: "succeeded", p_provider_ref: status.evidence.providerRef, p_amount: status.evidence.amount, p_currency: status.evidence.currency }
    : { p_attempt: attemptId, p_result: status.state };
  return record(admin, args);
}

/** Record evidence the provider gave us directly (the simulated provider's immediate success). */
export async function recordEvidence(admin: Rpc, attemptId: string, e: { providerRef: string; amount: number; currency: string }): Promise<Recorded> {
  return record(admin, { p_attempt: attemptId, p_result: "succeeded", p_provider_ref: e.providerRef, p_amount: e.amount, p_currency: e.currency });
}

async function record(admin: Rpc, args: Record<string, unknown>): Promise<Recorded> {
  let res;
  try { res = await admin.rpc("record_attempt_result", args); } catch { return { ok: false, code: "payment_record_failed" }; }
  if (res.error) return { ok: false, code: paymentCode(res.error, "payment_record_failed") };
  return { ok: true, outcome: String(res.data) };
}

/** `skipped`: open attempts of another provider than this runner's — never silently ignored (the run reports them). */
export type SweepSummary = { checked: number; skipped: number; outcomes: Record<string, number>; failures: Record<string, number> };

/**
 * The sweeper: attempts still open after `minAgeSeconds` (the player never came back, the callback never came, or it
 * was lost) are asked about again. Safe to run as often as wanted and alongside callbacks: every result goes through
 * the same idempotent function. Attempts of another provider than the configured one are left alone.
 */
export async function sweepOpenAttempts(admin: Rpc, provider: PaymentProvider,
  opts: { minAgeSeconds: number; maxAgeHours: number; limit: number; now?: Date; deadline?: number }): Promise<SweepSummary> {
  const summary: SweepSummary = { checked: 0, skipped: 0, outcomes: {}, failures: {} };
  const { data, error } = await admin.rpc("attempts_to_check", {
    p_min_age: `${Math.max(0, Math.floor(opts.minAgeSeconds))} seconds`,
    p_max_age: `${Math.max(1, Math.floor(opts.maxAgeHours))} hours`,
    p_limit: opts.limit,
  });
  if (error || !Array.isArray(data)) { summary.failures.list = 1; return summary; }
  for (const row of data as { attempt_id: string; provider: string; created_at?: string }[]) {
    if (row.provider !== provider.name) { summary.skipped++; continue; }
    if (opts.deadline !== undefined && Date.now() > opts.deadline) { summary.failures.out_of_time = (summary.failures.out_of_time ?? 0) + 1; break; }
    summary.checked++;
    const r = await verifyAndRecord(admin, provider, row.attempt_id, { createdAt: row.created_at, now: opts.now });
    const bucket = r.ok ? summary.outcomes : summary.failures;
    const key = r.ok ? r.outcome : r.code;
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  return summary;
}
