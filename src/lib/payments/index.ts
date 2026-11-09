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
export type { PaymentProvider } from "./provider";
