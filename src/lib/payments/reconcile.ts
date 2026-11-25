import "server-only";
import type { PaymentProvider, ProviderCharge } from "./provider";
import { paymentCode, sweepOpenAttempts, type Rpc, type SweepSummary } from "./attempts";

/**
 * M12.2 payment reconciliation, provider-independent. Safe to repeat and to run alongside callbacks and the player's
 * return page (every money write goes through the database's idempotent functions, 0094).
 *
 *  1. Sweep: every unresolved attempt, however old, is asked about again (oldest check first). One of another provider
 *     is counted, never silently skipped.
 *  2. Health (0095), read after the sweep: attempts of another provider than this runner's (misconfiguration),
 *     attempts still unresolved past the overdue age, reconciliation issues nobody has resolved yet. Each is a problem.
 *  3. Charge list (if the provider offers one): never before a person has set a verified starting point
 *     (initialise_reconciliation_watermark, 0095) — until then the run reports `reconciliation_not_initialised`.
 *     Then read from the watermark (minus an overlap) for at most one window,
 *     reconciled charge by charge. The watermark moves forward only when the whole window was processed, so a window
 *     that failed or ran out of time is read again, and a runner that was down catches up window by window. Evidence
 *     that contradicts a recorded charge is kept as an issue until a person resolves it.
 *
 * A run is successful only if it did everything and found nothing for a person: `problems` empty. Running out of the
 * time budget, being behind on the charge list, or any of the above is a problem (the route answers 500).
 */
export type ReconcileSummary = { seen: number; outcomes: Record<string, number>; conflicts: number; failures: Record<string, number> };

const CONFLICTS = new Set(["charge_evidence_conflict", "attempt_evidence_conflict", "duplicate_provider_ref"]);

export async function reconcileCharges(admin: Rpc, provider: PaymentProvider, charges: ProviderCharge[], opts: { deadline?: number } = {}): Promise<ReconcileSummary> {
  const s: ReconcileSummary = { seen: 0, outcomes: {}, conflicts: 0, failures: {} };
  const fail = (k: string) => { s.failures[k] = (s.failures[k] ?? 0) + 1; };
  for (const c of charges) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) { fail("out_of_time"); break; }
    s.seen++;
    let res;
    try {
      res = await admin.rpc("reconcile_provider_charge", {
        p_provider: provider.name, p_external_ref: c.externalRef ?? "", p_provider_ref: c.providerRef, p_amount: c.amount, p_currency: c.currency,
      });
    } catch { fail("record_failed"); continue; }
    if (res.error) {
      const code = paymentCode(res.error, "record_failed");
      if (!CONFLICTS.has(code)) { fail(code); continue; }
      // kept until a person resolves it (0095): reported on every run, not once. A conflict a person has already
      // resolved, seen again in a later window, is counted but not raised again.
      let kept;
      try {
        kept = await admin.rpc("record_reconciliation_issue", { p_provider: provider.name, p_provider_ref: c.providerRef, p_external_ref: c.externalRef, p_amount: c.amount, p_currency: c.currency, p_code: code });
      } catch { kept = { data: null, error: { message: "issue_record" } }; }
      if (kept.error) { s.conflicts++; fail("issue_record"); continue; }
      if (kept.data === "resolved") s.outcomes.resolved_conflict = (s.outcomes.resolved_conflict ?? 0) + 1;
      else s.conflicts++;
      continue;
    }
    const o = String(res.data);
    s.outcomes[o] = (s.outcomes[o] ?? 0) + 1;
  }
  return s;
}

export type Health = { other_provider_attempts: number; overdue_attempts: number; oldest_unresolved: string | null; open_issues: number; reconciled_until: string | null };
export type RunSummary = {
  health: Health | null; sweep: SweepSummary; reconcile: ReconcileSummary | null;
  window: { since: string; until: string; advanced: boolean } | null; problems: string[];
};

/**
 * overlapMinutes and maxWindowHours are PLACEHOLDERS for provider-independent tests. Before real payments they must be
 * chosen from the provider's verified behaviour (for Whish: how long after a charge it appears in the transaction
 * history — the overlap must exceed that delay — and how far back the history can be read — every window and the
 * initial starting point must stay inside that retention). Not verified for Whish yet.
 */
export const RECONCILE_DEFAULTS = {
  minAgeSeconds: 120,     // leave the player's own return page a moment first
  limit: 50,              // attempts asked about per run (oldest check first)
  overdueHours: 48,       // an attempt still unresolved after this needs a person
  overlapMinutes: 60,     // each charge window starts this far before the watermark (late-arriving provider records)
  maxWindowHours: 24,     // at most this much of the provider's list per run; further windows on the next runs
  budgetMs: 40_000,
};

/** One scheduled run. `problems` (codes only) is empty only when the run completed and needs nobody. */
export async function runPaymentReconciliation(admin: Rpc, provider: PaymentProvider, opts: Partial<typeof RECONCILE_DEFAULTS> & { now?: Date } = {}): Promise<RunSummary> {
  const o = { ...RECONCILE_DEFAULTS, ...opts };
  const now = opts.now ?? new Date();
  const deadline = Date.now() + o.budgetMs;
  const problems = new Set<string>();

  const sweep = await sweepOpenAttempts(admin, provider, { minAgeSeconds: o.minAgeSeconds, maxAgeHours: 24 * 365 * 10, limit: o.limit, now, deadline });
  if (sweep.failures.list) problems.add("sweep_list");
  if (sweep.failures.out_of_time) problems.add("incomplete");
  if (Object.keys(sweep.failures).some((k) => k !== "list" && k !== "out_of_time")) problems.add("sweep_failures");
  if (sweep.skipped > 0) problems.add("provider_mismatch");

  // health after the sweep: what is still unresolved once every attempt has been asked about
  let health: Health | null = null;
  try {
    const h = await admin.rpc("payment_reconciliation_health", { p_provider: provider.name, p_overdue: `${o.overdueHours} hours` });
    const row = Array.isArray(h.data) ? (h.data[0] as Health | undefined) : undefined;
    if (h.error || !row) problems.add("health"); else health = row;
  } catch { problems.add("health"); }
  if (health) {
    if (health.other_provider_attempts > 0) problems.add("provider_mismatch");
    if (health.overdue_attempts > 0) problems.add("overdue_attempts");
    if (health.open_issues > 0) problems.add("open_issues");
  }

  let reconcile: ReconcileSummary | null = null;
  let window: RunSummary["window"] = null;
  if (provider.listCharges) {
    if (!health) {
      problems.add("incomplete");                                     // no watermark: the charge list waits for the next run
    } else if (!health.reconciled_until) {
      // no verified starting point yet: nothing is read, and the run says so (500) until a person sets one
      problems.add("reconciliation_not_initialised");
    } else {
      const since = new Date(new Date(health.reconciled_until).getTime() - o.overlapMinutes * 60_000);
      const until = new Date(Math.min(now.getTime(), since.getTime() + o.maxWindowHours * 3_600_000));
      window = { since: since.toISOString(), until: until.toISOString(), advanced: false };
      let charges: ProviderCharge[] | null = null;
      try { charges = await provider.listCharges(since, until); } catch { problems.add("charge_list"); }
      if (charges) {
        reconcile = await reconcileCharges(admin, provider, charges, { deadline });
        if (reconcile.conflicts > 0) problems.add("conflicts");
        if (reconcile.failures.out_of_time) problems.add("incomplete");
        if (Object.keys(reconcile.failures).some((k) => k !== "out_of_time")) problems.add("reconcile_failures");
        if (Object.keys(reconcile.failures).length === 0) {
          // the whole window is done: move the watermark (forward only)
          const w = await admin.rpc("advance_reconciliation_watermark", { p_provider: provider.name, p_until: until.toISOString() }).then((x) => x, () => ({ error: { message: "x" } }));
          if (w.error) problems.add("watermark"); else window.advanced = true;
        }
      }
      if (!window.advanced || until.getTime() < now.getTime()) problems.add("reconciliation_behind");
    }
  }
  return { health, sweep, reconcile, window, problems: [...problems] };
}
