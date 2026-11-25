import "server-only";
import { PaymentStartRefused, type PaymentProvider } from "./provider";

/**
 * Charge-level coverage (review 25 Nov). A real-money provider (anything but `simulated`) must offer its own charge list
 * (listCharges), so that reconciliation can find a charge that has no attempt of ours. Without one, no new payment can
 * start. The only way round it is a specifically approved alternative: PAYMENT_ATTEMPTS_ONLY_APPROVAL names its
 * reference, and that reference must be in APPROVED_ATTEMPTS_ONLY_ALTERNATIVES below. Its own module so that every
 * start path (website and app) uses the same rule, and tests that replace "@/lib/payments" still run it.
 *
 * Decision (Paul, 25 Nov): the exception must never be activated without his explicit approval AND a documented
 * alternative financial reconciliation process. So the environment variable alone activates nothing: the
 * alternative must also be registered here, in a reviewed change that Paul approves, pointing at its committed
 * process document. Today none is registered.
 */
/** One approved alternative to a provider charge list. */
export interface AttemptsOnlyAlternative {
  /** The value PAYMENT_ATTEMPTS_ONLY_APPROVAL must equal. */
  ref: string;
  /** Who approved it (Paul), and the date (YYYY-MM-DD). */
  approvedBy: string;
  approvedOn: string;
  /** The committed process document, under docs/payments/ (how charges without an attempt of ours are found). */
  process: string;
}

/** Registered alternatives. Empty: no attempts-only operation is approved. */
export const APPROVED_ATTEMPTS_ONLY_ALTERNATIVES: readonly AttemptsOnlyAlternative[] = [];

/** True when an entry is complete enough to be one (the review checks its content). */
export function isCompleteAlternative(a: AttemptsOnlyAlternative): boolean {
  return a.ref.trim().length >= 3 && a.ref.length <= 200 && a.ref === a.ref.trim()
    && a.approvedBy.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(a.approvedOn)
    && /^docs\/payments\/[A-Za-z0-9._\/-]+\.md$/.test(a.process) && !a.process.includes("..");
}
/** The approved alternative in force: PAYMENT_ATTEMPTS_ONLY_APPROVAL names a registered, complete entry. Otherwise null. */
export function attemptsOnlyApproval(env: Record<string, string | undefined> = process.env,
  registry: readonly AttemptsOnlyAlternative[] = APPROVED_ATTEMPTS_ONLY_ALTERNATIVES): string | null {
  const a = (env.PAYMENT_ATTEMPTS_ONLY_APPROVAL ?? "").trim();
  if (!a) return null;
  const hit = registry.find((r) => r.ref === a && isCompleteAlternative(r));
  return hit ? hit.ref : null;
}

/** Charge-level coverage of a provider: "missing" for a real-money provider with no charge list and no approval. */
export function chargeCoverage(provider: Pick<PaymentProvider, "name" | "listCharges">, env: Record<string, string | undefined> = process.env,
  registry: readonly AttemptsOnlyAlternative[] = APPROVED_ATTEMPTS_ONLY_ALTERNATIVES):
  "full" | "simulated" | "approved_attempts_only" | "missing" {
  if (provider.listCharges) return "full";
  if (provider.name === "simulated") return "simulated";
  return attemptsOnlyApproval(env, registry) ? "approved_attempts_only" : "missing";
}

/** A real-money provider without charge-level reconciliation cannot start payments (see above). Asking about and
 *  settling existing attempts is unaffected. */
export function withCoverageGate(provider: PaymentProvider, env: Record<string, string | undefined> = process.env,
  registry: readonly AttemptsOnlyAlternative[] = APPROVED_ATTEMPTS_ONLY_ALTERNATIVES): PaymentProvider {
  if (chargeCoverage(provider, env, registry) !== "missing") return provider;
  // Object.create keeps every other method, whether the provider is a plain object or a class instance (a spread
  // would drop a class's methods).
  const gated: PaymentProvider = Object.create(provider);
  gated.startAttempt = async () => { throw new PaymentStartRefused("charge_reconciliation_unavailable"); };
  return gated;
}

