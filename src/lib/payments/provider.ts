import "server-only";

/**
 * Payment provider interface. The booking flow never talks to a gateway directly:
 * hold_slot() creates a pending payment; the app asks the provider to start it; the provider
 * (or its callback) reports the result; the server calls confirm_payment()/fail_payment()
 * with the service role. Swapping simulated → Whish/Areeba touches only this folder.
 */
export type StartPaymentInput = {
  /** Also the gateway idempotency key: a provider must never create two sessions for one paymentId. */
  paymentId: string;
  totalUsd: number;
  currency: "USD" | "LBP";
  description: string;
  /** Where the gateway should send the player back after paying / failing. */
  returnUrl: string;
  failUrl: string;
};

export type StartPaymentResult =
  | { kind: "redirect"; url: string; sessionRef: string } // hosted payment page; sessionRef identifies the gateway session for reuse
  | { kind: "immediate"; providerRef: string }; // ONLY the simulated provider may return this

export type VerifyResult =
  | { status: "paid"; providerRef: string; totalUsd: number }
  | { status: "failed"; reason: string }
  | { status: "pending" };

export interface PaymentProvider {
  readonly name: "simulated" | "whish" | "areeba";
  start(input: StartPaymentInput): Promise<StartPaymentResult>;
  /** Server-side truth about a payment (status API or verified callback payload). Never trust the browser. */
  verify(paymentId: string, providerRef: string | null): Promise<VerifyResult>;
  refund(providerRef: string, totalUsd: number): Promise<{ ok: boolean; reason?: string }>;
}
