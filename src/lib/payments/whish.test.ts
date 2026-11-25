// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { whishProvider } = await import("./whish");
const { PaymentStartRefused } = await import("./provider");

describe("the Whish stub (not implemented) can never leave a payment in an unknown state", () => {
  it("startAttempt is a definite refusal: nothing was sent", async () => {
    await expect(whishProvider.startAttempt({ attemptId: "a", amountUsd: 1, currency: "USD", description: "x", returnUrl: "https://x", callbackUrl: "https://x" }))
      .rejects.toBeInstanceOf(PaymentStartRefused);
  });
  it("it never reports a success", async () => {
    await expect(whishProvider.attemptStatus("a")).rejects.toThrow();
  });
});
