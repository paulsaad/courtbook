import "server-only";

/**
 * Payment provider interface. The booking flow never talks to a gateway directly, and never trusts what a browser or a
 * callback says about money: the server asks the provider (attemptStatus) and hands that answer to the database
 * (record_attempt_result, 0093), which alone decides what a successful charge means.
 *
 * Two flows:
 *  - Model 2 (fee_online clubs, M12.1): one ATTEMPT per request to the provider. The attempt's id is the external
 *    reference sent to the provider, so it is never reused. startAttempt / attemptStatus / callbackAttemptId.
 *  - Model 1 (court + fee online; demo clubs, simulated only): start / verify / refund, unchanged.
 * Swapping simulated → Whish touches only this folder.
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

/** What the provider says it took: its own id for the charge, the amount and the currency actually received. */
export type ChargeEvidence = { providerRef: string; amount: number; currency: string };

export type StartAttemptInput = {
  /** Our external reference for this attempt. Unique, never reused (a provider may replay a reused reference). */
  attemptId: string;
  amountUsd: number;
  currency: "USD";
  description: string;
  /** Configured CourtBook URLs only (src/lib/payments/urls.ts), never derived from the incoming request. */
  returnUrl: string;
  callbackUrl: string;
};

export type StartAttemptResult =
  | { kind: "redirect"; url: string; session: string }   // hosted payment page
  | { kind: "immediate"; evidence: ChargeEvidence };     // ONLY the simulated provider may return this

export type AttemptStatus =
  | { state: "succeeded"; evidence: ChargeEvidence }
  | { state: "failed" | "expired" | "pending" };

export type ProviderName = "simulated" | "whish" | "areeba";

export interface PaymentProvider {
  readonly name: ProviderName;
  start(input: StartPaymentInput): Promise<StartPaymentResult>;
  /** Server-side truth about a payment (status API or verified callback payload). Never trust the browser. */
  verify(paymentId: string, providerRef: string | null): Promise<VerifyResult>;
  refund(providerRef: string, totalUsd: number): Promise<{ ok: boolean; reason?: string }>;

  startAttempt(input: StartAttemptInput): Promise<StartAttemptResult>;
  /** The provider's own answer about an attempt, asked server to server. */
  attemptStatus(attemptId: string): Promise<AttemptStatus>;
  /** Reads ONLY which attempt a callback is about. Whatever else the callback claims is ignored: the server then asks
   *  attemptStatus. Absent for a provider that sends no callbacks (simulated). */
  callbackAttemptId?(request: Request): Promise<string | null>;
}
