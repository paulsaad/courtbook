import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bookingDurations } from "./durations";

// PR-9a: every length the club allows, from its minimum to its maximum in whole grid steps — the database's rule.
describe("bookingDurations", () => {
  it("the usual set-up (30-min grid, 1 h to 3 h): all five lengths, the maximum included", () => {
    expect(bookingDurations({ slotMinutes: 30, minMinutes: 60, maxMinutes: 180 })).toEqual([60, 90, 120, 150, 180]);
  });
  it("more than five lengths: none is dropped (the app used to show only four)", () => {
    expect(bookingDurations({ slotMinutes: 30, minMinutes: 30, maxMinutes: 240 })).toEqual([30, 60, 90, 120, 150, 180, 210, 240]);
    expect(bookingDurations({ slotMinutes: 15, minMinutes: 30, maxMinutes: 120 })).toEqual([30, 45, 60, 75, 90, 105, 120]);
  });
  it("minimum equal to maximum: exactly that one length", () => {
    expect(bookingDurations({ slotMinutes: 30, minMinutes: 90, maxMinutes: 90 })).toEqual([90]);
  });
  it("one-hour grid", () => {
    expect(bookingDurations({ slotMinutes: 60, minMinutes: 60, maxMinutes: 120 })).toEqual([60, 120]);
  });
  it("a minimum or maximum off the grid: only whole grid steps inside the range", () => {
    expect(bookingDurations({ slotMinutes: 30, minMinutes: 75, maxMinutes: 180 })).toEqual([90, 120, 150, 180]);
    expect(bookingDurations({ slotMinutes: 30, minMinutes: 60, maxMinutes: 200 })).toEqual([60, 90, 120, 150, 180]);
  });
  it("a minimum below one step starts at one step", () => {
    expect(bookingDurations({ slotMinutes: 30, minMinutes: 0, maxMinutes: 60 })).toEqual([30, 60]);
  });
  it("nothing allowed: no lengths rather than a wrong one", () => {
    expect(bookingDurations({ slotMinutes: 30, minMinutes: 120, maxMinutes: 90 })).toEqual([]);   // minimum above maximum
    expect(bookingDurations({ slotMinutes: 30, minMinutes: 60, maxMinutes: 45 })).toEqual([]);    // no whole step fits
    expect(bookingDurations({ slotMinutes: 0, minMinutes: 60, maxMinutes: 120 })).toEqual([]);
    expect(bookingDurations({ slotMinutes: -30, minMinutes: 60, maxMinutes: 120 })).toEqual([]);
    expect(bookingDurations({ slotMinutes: 30, minMinutes: Number.NaN, maxMinutes: 120 })).toEqual([]);
  });
  it("the app's copy is the same file (one rule for website and app)", () => {
    const here = readFileSync(join(__dirname, "durations.ts"), "utf8");
    expect(readFileSync(join(__dirname, "..", "..", "mobile", "shared", "durations.ts"), "utf8")).toBe(here);
  });
});
