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
    expect(attemptNotice({ status: "failed", outcome: null }, 2)).toBe("That payment did not go through. You can try again (2 tries left).");
    expect(attemptNotice({ status: "expired", outcome: null }, 1)).toContain("(1 try left)");
    expect(attemptNotice({ status: "failed", outcome: null }, 0)).toContain("No tries left");
  });
  it("money we could not use is promised back in full", () => {
    for (const o of ["late", "duplicate", "wrong_amount", "wrong_currency"]) expect(attemptNotice({ status: "succeeded", outcome: o }, 1)).toContain("refunded in full");
  });
  it("an open attempt waits for the provider", () => expect(attemptNotice({ status: "open", outcome: null }, 2)).toContain("Waiting for the payment provider"));
});
