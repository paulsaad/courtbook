import { describe, it, expect } from "vitest";
import { feeSummary } from "./fees";

/**
 * The club page advertised the configured fee regardless of payment mode, while an at-desk booking
 * is written with fee_usd = 0. These assert the page cannot say a fee is coming when none is.
 */
describe("what a player is told they will pay", () => {
  it("promises no fee at a club that takes payment at the desk", () => {
    const s = feeSummary("at_desk", 1);
    expect(s.fee).toBe("None");
    expect(s.payment).toContain("at the club");
  });

  it("does not call a simulated payment an online one", () => {
    // No money is collected in this mode, and the staff dashboard already says so.
    const s = feeSummary("simulated", 1);
    expect(s.fee).toBe("$1.00 per booking");
    expect(s.payment).toContain("no real money");
    expect(s.payment).not.toContain("online");
  });

  it("states the fee as paid online only for a live gateway", () => {
    const s = feeSummary("whish", 1);
    expect(s.fee).toBe("$1.00 per booking");
    expect(s.payment).toContain("online");
  });

  it("says none when the club is configured with no fee", () => {
    expect(feeSummary("simulated", 0).fee).toBe("None");
  });

  it("treats an unknown mode as online rather than inventing a free booking", () => {
    // Safer to overstate the cost than to promise free and then charge.
    expect(feeSummary("something_new", 1).fee).toBe("$1.00 per booking");
    expect(feeSummary("something_new", 1).payment).toContain("online");
  });

  it("accepts the string a database row actually carries", () => {
    expect(feeSummary("simulated", "1.00").fee).toBe("$1.00 per booking");
  });
});
