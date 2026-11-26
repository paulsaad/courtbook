import { describe, expect, it } from "vitest";
import { placeLine } from "./ClubHeader";

describe("club header place line (C1)", () => {
  it("a town named like its district is said once", () => expect(placeLine("Batroun", "Batroun")).toBe("Batroun"));
  it("case and spaces do not matter", () => expect(placeLine("Zgharta ", "zgharta")).toBe("Zgharta "));
  it("different names: both", () => expect(placeLine("Amioun", "Koura")).toBe("Amioun · Koura"));
  it("one missing: the other; none: Lebanon", () => {
    expect(placeLine(null, "Koura")).toBe("Koura");
    expect(placeLine(null, null)).toBe("Lebanon");
  });
});
