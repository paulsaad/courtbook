import { describe, it, expect } from "vitest";
import { feeSummary, reserveText } from "./fees";

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

describe("fee_online (M12.1): court at the club, CourtBook's fee online", () => {
  it("says the fee is paid online and kept on cancellation, and that the court is paid at the club", () => {
    const s = feeSummary("fee_online", 1);
    expect(s.fee).toBe("$1.00 per booking, paid online — not refunded if you cancel");
    expect(s.payment).toContain("court at the club");
  });
  it("a $0 fee is the pay-at-the-desk path: nothing online is promised", () => {
    expect(feeSummary("fee_online", 0)).toEqual({ fee: "None", payment: "Pay the court at the club when you arrive." });
  });
});

describe("reserveText: the reserve sheet's words", () => {
  it("fee_online: the amount now is only the fee; the court is shown as paid at the club", () => {
    const t = reserveText("fee_online", 1, 25, 10, 6);
    expect(t).toEqual({ label: "Court $25.00 at the club + booking fee now", amount: "$1.00", button: "Reserve and pay the $1.00 booking fee",
      note: "Slot held 10 minutes while you pay the booking fee · it is not refunded if you cancel" });
  });
  it("fee_online at $0 and at_desk read the same", () => {
    expect(reserveText("fee_online", 0, 25, 10, 6)).toEqual(reserveText("at_desk", 1, 25, 10, 6));
    expect(reserveText("at_desk", 1, 25, 10, 6).amount).toBe("$25.00");
  });
  it("simulated (Model 1): court + fee, total", () => {
    const t = reserveText("simulated", 1, 25, 10, 6);
    expect([t.label, t.amount, t.button]).toEqual(["Court $25.00 + booking fee $1.00", "$26.00", "Reserve and pay $26.00"]);
  });
  it("before the price is known", () => expect(reserveText("fee_online", 1, null, 10, 6).label).toBe("Court … at the club + booking fee now"));
});
