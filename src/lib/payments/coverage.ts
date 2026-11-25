import "server-only";
import { PaymentStartRefused, type PaymentProvider } from "./provider";

/**
 * Charge-level coverage (review 25 Nov). A real-money provider (anything but `simulated`) must offer its own charge list
 * (listCharges), so that reconciliation can find a charge that has no attempt of ours. Without one, no new payment can
 * start; the only way round it is a specifically approved alternative named in PAYMENT_ATTEMPTS_ONLY_APPROVAL (an
 * approval reference). Its own module so that every start path (website and app) uses the same rule, and tests that
 * replace "@/lib/payments" still run it.
 */
/** The approved alternative to a charge list, if one was configured (its reference only; never a secret). */
export function attemptsOnlyApproval(env: Record<string, string | undefined> = process.env): string | null {
  const a = (env.PAYMENT_ATTEMPTS_ONLY_APPROVAL ?? "").trim();
  return a.length >= 3 && a.length <= 200 ? a : null;
}

/** Charge-level coverage of a provider: "missing" for a real-money provider with no charge list and no approval. */
export function chargeCoverage(provider: Pick<PaymentProvider, "name" | "listCharges">, env: Record<string, string | undefined> = process.env):
  "full" | "simulated" | "approved_attempts_only" | "missing" {
  if (provider.listCharges) return "full";
  if (provider.name === "simulated") return "simulated";
  return attemptsOnlyApproval(env) ? "approved_attempts_only" : "missing";
}

/** A real-money provider without charge-level reconciliation cannot start payments (see above). Asking about and
 *  settling existing attempts is unaffected. */
export function withCoverageGate(provider: PaymentProvider, env: Record<string, string | undefined> = process.env): PaymentProvider {
  if (chargeCoverage(provider, env) !== "missing") return provider;
  // Object.create keeps every other method, whether the provider is a plain object or a class instance (a spread
  // would drop a class's methods).
  const gated: PaymentProvider = Object.create(provider);
  gated.startAttempt = async () => { throw new PaymentStartRefused("charge_reconciliation_unavailable"); };
  return gated;
}

