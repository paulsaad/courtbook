import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { existsSync } from "node:fs";
import {
  APPROVED_ATTEMPTS_ONLY_ALTERNATIVES, attemptsOnlyApproval, chargeCoverage, getProvider, isCompleteAlternative,
  paymentConfigProblem, withCoverageGate, type AttemptsOnlyAlternative,
} from "./index";
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
  it("...with a registered, approved alternative AND its reference in PAYMENT_ATTEMPTS_ONLY_APPROVAL: it may start", async () => {
    const registry: AttemptsOnlyAlternative[] = [
      { ref: "ALT-1", approvedBy: "Paul", approvedOn: "2026-12-01", process: "docs/payments/alt-1.md" },
    ];
    const env = { PAYMENT_ATTEMPTS_ONLY_APPROVAL: "ALT-1" };
    const g = realWithoutList();
    expect(chargeCoverage(g, env, registry)).toBe("approved_attempts_only");
    expect(await withCoverageGate(g, env, registry).startAttempt(START)).toMatchObject({ url: expect.stringMatching(/^https:/) });
  });
  it("decision 25 Nov: the environment variable alone activates nothing; an unregistered reference is a configuration problem", async () => {
    const env = { PAYMENT_ATTEMPTS_ONLY_APPROVAL: "Paul 2026-12-01, doc X" };
    expect(attemptsOnlyApproval(env)).toBeNull();
    expect(chargeCoverage(realWithoutList(), env)).toBe("missing");
    await expect(withCoverageGate(realWithoutList(), env).startAttempt(START)).rejects.toMatchObject({ reason: "charge_reconciliation_unavailable" });
    expect(paymentConfigProblem(env)).toBe("attempts_only_approval_invalid");
    // the reference of a registered entry must match exactly
    const registry: AttemptsOnlyAlternative[] = [{ ref: "ALT-1", approvedBy: "Paul", approvedOn: "2026-12-01", process: "docs/payments/alt-1.md" }];
    expect(attemptsOnlyApproval({ PAYMENT_ATTEMPTS_ONLY_APPROVAL: "ALT-2" }, registry)).toBeNull();
    expect(attemptsOnlyApproval({ PAYMENT_ATTEMPTS_ONLY_APPROVAL: " ALT-1 " }, registry)).toBe("ALT-1");
  });
  it("an incomplete registry entry (no approver, no date, no process document) approves nothing", () => {
    const base = { ref: "ALT-1", approvedBy: "Paul", approvedOn: "2026-12-01", process: "docs/payments/alt-1.md" };
    expect(isCompleteAlternative(base)).toBe(true);
    for (const bad of [
      { ...base, approvedBy: " " }, { ...base, approvedOn: "1 Dec" }, { ...base, process: "" },
      { ...base, process: "notes/alt.md" }, { ...base, process: "docs/payments/../x.md" }, { ...base, ref: "x" },
    ]) {
      expect(isCompleteAlternative(bad)).toBe(false);
      expect(attemptsOnlyApproval({ PAYMENT_ATTEMPTS_ONLY_APPROVAL: bad.ref }, [bad])).toBeNull();
    }
  });
  it("today no alternative is registered; every registered one names a committed process document", () => {
    expect(APPROVED_ATTEMPTS_ONLY_ALTERNATIVES).toEqual([]);   // adding one needs Paul's approval (decision 25 Nov)
    for (const a of APPROVED_ATTEMPTS_ONLY_ALTERNATIVES) {
      expect(isCompleteAlternative(a)).toBe(true);
      expect(existsSync(a.process)).toBe(true);
    }
  });
  it("a blank approval is no approval and not a problem; a non-blank unregistered one is a problem", () => {
    for (const a of ["", "  "]) expect(paymentConfigProblem({ PAYMENT_ATTEMPTS_ONLY_APPROVAL: a })).toBeNull();
    for (const a of ["x", "y".repeat(201), "anything"]) {
      expect(attemptsOnlyApproval({ PAYMENT_ATTEMPTS_ONLY_APPROVAL: a })).toBeNull();
      expect(paymentConfigProblem({ PAYMENT_ATTEMPTS_ONLY_APPROVAL: a })).toBe("attempts_only_approval_invalid");
    }
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
