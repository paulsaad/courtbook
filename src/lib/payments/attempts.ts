import "server-only";
import type { PaymentProvider } from "./provider";

/**
 * Provider-independent handling of payment attempts (M12.1, 0093). Three callers share it, so they cannot disagree:
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
]);

/** The database's refusal as a known code, or `fallback`. The raw message never leaves the server. */
export function paymentCode(error: { message?: string } | null | undefined, fallback: string): string {
  const m = error?.message?.trim() ?? "";
  return PAYMENT_CODES.has(m) ? m : fallback;
}

export type Recorded =
  | { ok: true; outcome: string }
  | { ok: false; code: "provider_unavailable" | "payment_record_failed" | string };

/** Ask the provider about one attempt, then record what it says. */
export async function verifyAndRecord(admin: Rpc, provider: PaymentProvider, attemptId: string): Promise<Recorded> {
  let status;
  try { status = await provider.attemptStatus(attemptId); } catch { return { ok: false, code: "provider_unavailable" }; }
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

export type SweepSummary = { checked: number; outcomes: Record<string, number>; failures: Record<string, number> };

/**
 * The sweeper: attempts still open after `minAgeSeconds` (the player never came back, the callback never came, or it
 * was lost) are asked about again. Safe to run as often as wanted and alongside callbacks: every result goes through
 * the same idempotent function. Attempts of another provider than the configured one are left alone.
 */
export async function sweepOpenAttempts(admin: Rpc, provider: PaymentProvider, opts: { minAgeSeconds: number; maxAgeHours: number; limit: number }): Promise<SweepSummary> {
  const summary: SweepSummary = { checked: 0, outcomes: {}, failures: {} };
  const { data, error } = await admin.rpc("attempts_to_check", {
    p_min_age: `${Math.max(0, Math.floor(opts.minAgeSeconds))} seconds`,
    p_max_age: `${Math.max(1, Math.floor(opts.maxAgeHours))} hours`,
    p_limit: opts.limit,
  });
  if (error || !Array.isArray(data)) { summary.failures.list = 1; return summary; }
  for (const row of data as { attempt_id: string; provider: string }[]) {
    if (row.provider !== provider.name) continue;
    summary.checked++;
    const r = await verifyAndRecord(admin, provider, row.attempt_id);
    const bucket = r.ok ? summary.outcomes : summary.failures;
    const key = r.ok ? r.outcome : r.code;
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  return summary;
}
