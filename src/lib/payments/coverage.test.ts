import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { attemptsOnlyApproval, chargeCoverage, getProvider, paymentConfigProblem, withCoverageGate } from "./index";
import { FakeGateway } from "./testing/fakeGateway";
import { PaymentStartRefused } from "./provider";

/**
 * Review 25 Nov: real payments must not start unless a charge that has no attempt of ours can be found — the provider's
 * own charge list — or a specifically approved alternative is configured. Asking about existing attempts is unaffected.
 */
const START = { attemptId: "0d000000-0000-4000-8000-000000000001", amountUsd: 1, currency: "USD" as const, description: "fee", returnUrl: "https://x.example/r", callbackUrl: "https://x.example/c" };
function realWithoutList() {
  const g = new FakeGateway(() => Date.now());
  (g as { listCharges?: unknown }).listCharges = undefined;
  return g;   // named "whish": a real-money provider
}

describe("charge-level coverage gate", () => {
  it("a real-money provider without a charge list: coverage missing, a payment cannot start, status still answered", async () => {
    const g = realWithoutList();
    expect(chargeCoverage(g, {})).toBe("missing");
    const gated = withCoverageGate(g, {});
    await expect(gated.startAttempt(START)).rejects.toThrow(PaymentStartRefused);
    await expect(gated.startAttempt(START)).rejects.toMatchObject({ reason: "charge_reconciliation_unavailable" });
    await g.startAttempt({ ...START, attemptId: "0d000000-0000-4000-8000-000000000002" });   // an attempt made earlier
    expect((await gated.attemptStatus("0d000000-0000-4000-8000-000000000002")).state).toBe("pending");
  });
  it("...with a specifically approved alternative (its reference in PAYMENT_ATTEMPTS_ONLY_APPROVAL): it may start", async () => {
    const env = { PAYMENT_ATTEMPTS_ONLY_APPROVAL: "Paul 2026-12-01, doc X" };
    const g = realWithoutList();
    expect(chargeCoverage(g, env)).toBe("approved_attempts_only");
    expect(await withCoverageGate(g, env).startAttempt(START)).toMatchObject({ url: expect.stringMatching(/^https:/) });
  });
  it("a blank or absurd approval is no approval, and is itself a configuration problem", () => {
    for (const a of ["", "  ", "x", "y".repeat(201)]) expect(attemptsOnlyApproval({ PAYMENT_ATTEMPTS_ONLY_APPROVAL: a })).toBeNull();
    expect(chargeCoverage(realWithoutList(), { PAYMENT_ATTEMPTS_ONLY_APPROVAL: "x" })).toBe("missing");
    expect(paymentConfigProblem({ PAYMENT_ATTEMPTS_ONLY_APPROVAL: "x" })).toBe("attempts_only_approval_invalid");
  });
  it("a provider with its own charge list: full; the simulated provider (no money): not gated", async () => {
    expect(chargeCoverage(new FakeGateway(() => 0), {})).toBe("full");
    expect(chargeCoverage(getProvider({}), {})).toBe("simulated");
    expect(paymentConfigProblem({})).toBeNull();
    expect(paymentConfigProblem({ PAYMENT_PROVIDER: "simulated" })).toBeNull();
  });
  it("the Whish adapter stays not implemented (refuses every start), reported first", async () => {
    expect(paymentConfigProblem({ PAYMENT_PROVIDER: "whish" })).toBe("provider_not_implemented");
    await expect(getProvider({ PAYMENT_PROVIDER: "whish" }).startAttempt(START)).rejects.toThrow(PaymentStartRefused);
  });
});
