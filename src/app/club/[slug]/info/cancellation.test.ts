import { describe, expect, it } from "vitest";
import { cancellationLine } from "./cancellation";

describe("club Info cancellation line (W1)", () => {
  it("pay at the club: no refund wording, because nothing was paid through CourtBook", () => {
    const l = cancellationLine("at_desk", 6);
    expect(l).toEqual({ label: "Cancellation", text: "Free until 6 h before. Nothing is paid through CourtBook." });
    expect(l.text).not.toMatch(/refund/);
  });
  it("paid in the app (simulated or a real provider): the refund rule as before", () => {
    for (const mode of ["simulated", "whish", null])
      expect(cancellationLine(mode, 12)).toEqual({ label: "Free cancellation", text: "until 12 h before; no refund after" });
  });
});
