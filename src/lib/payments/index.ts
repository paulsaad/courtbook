import "server-only";
import { PaymentStartRefused, type PaymentProvider } from "./provider";
import { guardProvider, ProviderAnswerInvalid } from "./guard";
import { simulatedProvider } from "./simulated";
import { attemptsOnlyApproval, chargeCoverage, withCoverageGate } from "./coverage";
import { whishProvider } from "./whish";

/**
 * The deployment's payment provider, from PAYMENT_PROVIDER, always behind the provider contract (guard.ts).
 * Must match payments.provider set by hold_slot (database setting app.payment_provider) — both default to 'simulated'.
 *
 *   unset or ""   simulated (demo clubs only: the database refuses a simulated fee anywhere else, 0070/0093)
 *   "simulated"   simulated
 *   "whish"       the Whish adapter — NOT IMPLEMENTED: it refuses every start and answers nothing (whish.ts)
 *   anything else a misconfiguration (M12.3): before, a typo silently meant "simulated". Now nothing can start and
 *                 nothing is ever answered about an attempt (never "failed", never "paid"); the reconciliation run
 *                 reports provider_mismatch for every waiting attempt, and paymentConfigProblem says why.
 *
 * PAYMENT_PAGE_HOSTS (optional, comma-separated host names): the only hosts a payment page may be on.
 *
 * Charge-level coverage (review 25 Nov). A real-money provider (anything but `simulated`) must offer its own charge list
 * (listCharges), so that reconciliation can find a charge that has no attempt of ours (a second charge on a page, a
 * foreign reference). Without one, no new payment can START (`charge_reconciliation_unavailable`); existing attempts are
 * still asked about and settled. The only way round it is a specifically approved alternative, named in
 * PAYMENT_ATTEMPTS_ONLY_APPROVAL (an approval reference, e.g. a document and date). Even then every reconciliation run
 * reports `coverage_attempts_only_approved` as a warning.
 */
const UNCONFIGURED = "unconfigured";

function unconfiguredProvider(): PaymentProvider {
  const no = async (): Promise<never> => { throw new ProviderAnswerInvalid("provider_unconfigured"); };
  return {
    name: UNCONFIGURED as PaymentProvider["name"],
    start: no, verify: no, refund: async () => ({ ok: false, reason: "provider_unconfigured" }),
    async startAttempt() { throw new PaymentStartRefused("provider_unconfigured"); },
    attemptStatus: no,
  };
}

export function pageHosts(env: Record<string, string | undefined> = process.env): string[] {
  return (env.PAYMENT_PAGE_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]{1,253}$/.test(h));
}

/** null when the payment configuration is coherent; otherwise a code for the operator (never secret values). */
export function paymentConfigProblem(env: Record<string, string | undefined> = process.env): string | null {
  const p = (env.PAYMENT_PROVIDER ?? "").trim();
  if (p !== env.PAYMENT_PROVIDER && env.PAYMENT_PROVIDER !== undefined) return "provider_name_whitespace";
  if (p !== "" && p !== "simulated" && p !== "whish") return "provider_unknown";
  if (p === "whish") return "provider_not_implemented";
  if ((env.PAYMENT_PAGE_HOSTS ?? "").trim() && pageHosts(env).length === 0) return "page_hosts_invalid";
  if ((env.PAYMENT_ATTEMPTS_ONLY_APPROVAL ?? "").trim() && !attemptsOnlyApproval(env)) return "attempts_only_approval_invalid";
  if (chargeCoverage(getProvider(env), env) === "missing") return "charge_reconciliation_unavailable";
  return null;
}

export function getProvider(env: Record<string, string | undefined> = process.env): PaymentProvider {
  const raw = env.PAYMENT_PROVIDER;
  const base = raw === undefined || raw === "" || raw === "simulated" ? simulatedProvider
    : raw === "whish" ? whishProvider
    : unconfiguredProvider();
  return withCoverageGate(guardProvider(base, { pageHosts: pageHosts(env) }), env);
}

/** The provider an attempt or a callback names — only if it is the one this deployment is configured for. A row
 *  written under another configuration is not answered by guessing. */
export function providerNamed(name: string | null | undefined): PaymentProvider | null {
  const p = getProvider();
  return name === p.name ? p : null;
}
export { attemptsOnlyApproval, chargeCoverage, withCoverageGate } from "./coverage";
export type { PaymentProvider, ProviderName } from "./provider";
