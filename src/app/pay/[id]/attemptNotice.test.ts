import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
import { attemptNotice } from "./PayPanel";

/** What the player reads after a fee attempt (M12.1). */
describe("attemptNotice", () => {
  it("nothing before any attempt, and nothing after a confirmed one", () => {
    expect(attemptNotice(null, 3)).toBeNull();
    expect(attemptNotice({ status: "succeeded", outcome: "confirmed" }, 2)).toBeNull();
  });
  it("a failed or expired attempt says how many tries are left", () => {
    expect(attemptNotice({ status: "failed", outcome: null, endReason: "provider_failed" }, 2)).toBe("That payment did not go through. You can try again (2 tries left).");
    expect(attemptNotice({ status: "expired", outcome: null }, 1)).toContain("(1 try left)");
    expect(attemptNotice({ status: "failed", outcome: null }, 0)).toContain("No tries left");
  });
  // 0098 (M12 review S3): only the provider's own refusal or expiry (or never sent) is "did not go through"
  it("CourtBook's own timeout, or no recorded reason: never 'did not go through'", () => {
    for (const a of [{ status: "expired", outcome: null, endReason: "unknown_timeout" }, { status: "expired", outcome: null }, { status: "failed", outcome: null, endReason: null }])
      expect(attemptNotice(a, 2)).toBe("We couldn't confirm that payment. If you were charged, the fee will be refunded. You can try again (2 tries left).");
    for (const r of ["provider_failed", "provider_expired", "abandoned"])
      expect(attemptNotice({ status: r === "provider_expired" ? "expired" : "failed", outcome: null, endReason: r }, 2)).toMatch(/^That payment did not go through/);
  });
  it("money we could not use is promised back in full", () => {
    for (const o of ["late", "duplicate", "wrong_amount", "wrong_currency"]) expect(attemptNotice({ status: "succeeded", outcome: o }, 1)).toContain("refunded in full");
  });
  it("an open attempt waits for the provider", () => expect(attemptNotice({ status: "open", outcome: null }, 2)).toContain("Waiting for the payment provider"));
});
