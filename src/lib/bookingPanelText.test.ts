import { describe, expect, it } from "vitest";
import { bookingPanelText, reserveText } from "./fees";

const base = { courtUsd: 30, serviceFeeUsd: 1, holdMinutes: 10, cutoffHours: 6, signedIn: true, busy: false };

describe("booking panel wording follows the club's payment mode (W1)", () => {
  it("at the desk: no fee, no total with a fee, no paying, no hold", () => {
    const t = bookingPanelText({ ...base, mode: "at_desk" });
    expect(t).toEqual({
      priceLine: "Pay at the club",
      total: "$30.00",
      button: "Reserve — you pay at the club",
      footnote: "Confirmed straight away · nothing is paid through the app · free cancellation until 6 h before",
    });
    expect(JSON.stringify(t)).not.toMatch(/fee \$|\$31|while you pay|Reserve and pay/);
  });
  it("at the desk, even when the club row still carries a service fee", () => {
    expect(bookingPanelText({ ...base, mode: "at_desk", serviceFeeUsd: "2.50" }).total).toBe("$30.00");
  });
  it("paid in the app (simulated): court + fee, the total, a held slot", () => {
    expect(bookingPanelText({ ...base, mode: "simulated" })).toEqual({
      priceLine: "Court $30.00 + booking fee $1.00",
      total: "$31.00",
      button: "Reserve and pay $31.00",
      footnote: "Demo club: no real money is charged · Slot held 10 minutes while you pay · free cancellation until 6 h before",
    });
  });
  it("an unknown mode is treated as paid in the app (never promises free), without the demo note", () => {
    expect(bookingPanelText({ ...base, mode: "card_gateway" }).total).toBe("$31.00");
    expect(bookingPanelText({ ...base, mode: "card_gateway" }).footnote).not.toContain("no real money");
    expect(bookingPanelText({ ...base, mode: null }).button).toBe("Reserve and pay $31.00");
  });
  it("fee online (M12.1): the court at the club, only the fee now, kept on cancel; no demo note", () => {
    expect(bookingPanelText({ ...base, mode: "fee_online" })).toEqual({
      priceLine: "Court $30.00 at the club + booking fee now",
      total: "$1.00",
      button: "Reserve and pay the $1.00 booking fee",
      footnote: "Slot held 10 minutes while you pay the booking fee · it is not refunded if you cancel",
    });
  });
  it("fee online with a $0 fee reads exactly like the desk", () => {
    expect(bookingPanelText({ ...base, mode: "fee_online", serviceFeeUsd: 0 })).toEqual(bookingPanelText({ ...base, mode: "at_desk" }));
  });
  it("reserveText (M12.1's shape) is the same rule", () => {
    for (const mode of ["at_desk", "fee_online", "simulated", null]) {
      const p = bookingPanelText({ ...base, mode }); const r = reserveText(mode, 1, 30, 10, 6);
      expect(r).toEqual({ label: p.priceLine, amount: p.total, button: p.button, note: p.footnote });
    }
  });
  it("price still loading, signed out, busy", () => {
    expect(bookingPanelText({ ...base, mode: "at_desk", courtUsd: null }).total).toBe("…");
    expect(bookingPanelText({ ...base, mode: "simulated", courtUsd: null })).toMatchObject({ priceLine: "Court … + booking fee $1.00", total: "…", button: "Reserve and pay" });
    expect(bookingPanelText({ ...base, mode: "at_desk", signedIn: false }).button).toBe("Sign in to reserve");
    expect(bookingPanelText({ ...base, mode: "simulated", busy: true }).button).toBe("Reserving…");
  });
});
