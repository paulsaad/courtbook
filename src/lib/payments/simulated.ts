import "server-only";
import type { AttemptStatus, PaymentProvider, StartAttemptInput, StartAttemptResult, StartPaymentInput, StartPaymentResult, VerifyResult } from "./provider";

/** Demo clubs only (0070, 0094): every payment succeeds instantly for exactly what was asked; nothing is collected
 *  (payments.collected and fee_charges.collected stay false); refunds are recorded, not executed. */
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
  async startAttempt(input: StartAttemptInput): Promise<StartAttemptResult> {
    return { kind: "immediate", evidence: { providerRef: `SIM-${input.attemptId}`, amount: input.amountUsd, currency: input.currency } };
  },
  async attemptStatus(): Promise<AttemptStatus> {
    // A simulated attempt is recorded in the same request that starts it. One still open later was interrupted before
    // that: nothing was (or could be) charged, so it has expired.
    return { state: "expired" };
  },
};
