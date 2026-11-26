import { describe, expect, it } from "vitest";
import { normalizePhone } from "./phone";

describe("normalizePhone", () => {
  // H12 (Session B's round-3 handover): the Lebanese trunk 0 after the country code was kept, giving +96103123456,
  // which is not a reachable number (WhatsApp links fail)
  it.each([
    ["+961 03 123 456", "+9613123456"],
    ["00961 03 123 456", "+9613123456"],
    ["961 03 123 456", "+9613123456"],
    ["+961 070 123 456", "+96170123456"],
    ["+961 01 234 567", "+9611234567"],
    ["+961 081 234 567", "+96181234567"],
  ])("%s → %s (trunk 0 dropped)", (raw, want) => expect(normalizePhone(raw)).toBe(want));

  it.each([
    ["+961 3 123 456", "+9613123456"],
    ["03 123 456", "+9613123456"],
    ["70 123 456", "+96170123456"],
    ["+961 70 123 456", "+96170123456"],
    ["+46 70 123 45 67", "+46701234567"],
    ["0049 7633 50623", "+49763350623"],
    ["+39 06 1234 5678", "+390612345678"],   // Italy: the 0 after +39 is part of the number and stays
  ])("%s → %s (unchanged)", (raw, want) => expect(normalizePhone(raw)).toBe(want));

  it.each(["", "abc", "+961", "12"])("%j is refused", (raw) => expect(normalizePhone(raw)).toBeNull());
});
