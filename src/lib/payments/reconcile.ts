import "server-only";
import type { PaymentProvider, ProviderCharge } from "./provider";
import { paymentCode, sweepOpenAttempts, type Rpc, type SweepSummary } from "./attempts";

/**
 * M12.2 payment reconciliation, provider-independent. Two passes, both safe to repeat and to run alongside callbacks
 * and the player's return page (every write goes through the database's idempotent functions, 0093):
 *
 *  1. Sweep: every attempt still open is asked about again (attemptStatus). Catches lost callbacks, players who never
 *     came back, starts that timed out, and pages that expired without a word.
 *  2. Reconcile: if the provider offers a list of its successful charges (listCharges), every one of them in the
 *     look-back window is handed to reconcile_provider_charge. A charge we never heard of is recorded and owed back;
 *     a second charge on an attempt already paid is recorded as an extra charge, owed back; a charge that contradicts
 *     what is recorded is a CONFLICT — counted, alerted, never treated as a success.
 *
 * The look-back window is re-read on every run (no cursor to lose): repeating it changes nothing.
 */
export type ReconcileSummary = { seen: number; outcomes: Record<string, number>; conflicts: number; failures: Record<string, number> };

export async function reconcileCharges(admin: Rpc, provider: PaymentProvider, charges: ProviderCharge[], opts: { deadline?: number } = {}): Promise<ReconcileSummary> {
  const s: ReconcileSummary = { seen: 0, outcomes: {}, conflicts: 0, failures: {} };
  for (const c of charges) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) { s.failures.out_of_time = (s.failures.out_of_time ?? 0) + 1; break; }
    s.seen++;
    let res;
    try {
      res = await admin.rpc("reconcile_provider_charge", {
        p_provider: provider.name, p_external_ref: c.externalRef ?? "", p_provider_ref: c.providerRef, p_amount: c.amount, p_currency: c.currency,
      });
    } catch { s.failures.record_failed = (s.failures.record_failed ?? 0) + 1; continue; }
    if (res.error) {
      const code = paymentCode(res.error, "record_failed");
      if (code === "charge_evidence_conflict" || code === "attempt_evidence_conflict" || code === "duplicate_provider_ref") s.conflicts++;
      else s.failures[code] = (s.failures[code] ?? 0) + 1;
      continue;
    }
    const o = String(res.data);
    s.outcomes[o] = (s.outcomes[o] ?? 0) + 1;
  }
  return s;
}

export type RunSummary = { sweep: SweepSummary; reconcile: ReconcileSummary | null; problems: string[] };

export const SWEEP_DEFAULTS = { minAgeSeconds: 120, maxAgeHours: 48, limit: 50, lookbackHours: 48, budgetMs: 40_000 };

/** One scheduled run: sweep, then reconcile. `problems` (codes only) is non-empty when the run needs a person. */
export async function runPaymentReconciliation(admin: Rpc, provider: PaymentProvider, opts: Partial<typeof SWEEP_DEFAULTS> & { now?: Date } = {}): Promise<RunSummary> {
  const o = { ...SWEEP_DEFAULTS, ...opts };
  const now = opts.now ?? new Date();
  const deadline = Date.now() + o.budgetMs;
  const problems: string[] = [];

  const sweep = await sweepOpenAttempts(admin, provider, { minAgeSeconds: o.minAgeSeconds, maxAgeHours: o.maxAgeHours, limit: o.limit, now, deadline });
  if (sweep.failures.list) problems.push("sweep_list");
  if (Object.keys(sweep.failures).some((k) => k !== "list" && k !== "out_of_time")) problems.push("sweep_failures");

  let reconcile: ReconcileSummary | null = null;
  if (provider.listCharges) {
    let charges: ProviderCharge[] | null = null;
    try { charges = await provider.listCharges(new Date(now.getTime() - o.lookbackHours * 3_600_000), now); } catch { problems.push("charge_list"); }
    if (charges) {
      reconcile = await reconcileCharges(admin, provider, charges, { deadline });
      if (reconcile.conflicts > 0) problems.push("conflicts");
      if (Object.keys(reconcile.failures).some((k) => k !== "out_of_time")) problems.push("reconcile_failures");
    }
  }
  return { sweep, reconcile, problems };
}
