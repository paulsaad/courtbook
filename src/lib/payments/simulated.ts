import "server-only";
import type { PaymentProvider, StartPaymentInput, StartPaymentResult, VerifyResult } from "./provider";

/** Milestone A: every payment succeeds instantly; refunds are recorded, not executed. */
export const simulatedProvider: PaymentProvider = {
  name: "simulated",
  async start(input: StartPaymentInput): Promise<StartPaymentResult> {
    return { kind: "immediate", providerRef: `SIM-${input.paymentId.slice(0, 8)}` };
  },
  async verify(paymentId: string, providerRef: string | null): Promise<VerifyResult> {
    // With no gateway, the only truth is our own DB state; the route passes the DB total.
    return { status: "paid", providerRef: providerRef ?? `SIM-${paymentId.slice(0, 8)}`, totalUsd: NaN };
  },
  async refund() {
    return { ok: true };
  },
};
