import "server-only";
import type { PaymentProvider } from "./provider";
import { simulatedProvider } from "./simulated";
import { whishProvider } from "./whish";

/** Selected by env var PAYMENT_PROVIDER (default simulated). Must match payments.provider set by hold_slot
 *  (DB setting app.payment_provider) — both default to 'simulated'. */
export function getProvider(): PaymentProvider {
  switch (process.env.PAYMENT_PROVIDER) {
    case "whish": return whishProvider;
    default: return simulatedProvider;
  }
}

/** The provider an attempt or a callback names — only if it is the one this deployment is configured for. A row
 *  written under another configuration is not answered by guessing. */
export function providerNamed(name: string | null | undefined): PaymentProvider | null {
  const p = getProvider();
  return name === p.name ? p : null;
}
export type { PaymentProvider, ProviderName } from "./provider";
