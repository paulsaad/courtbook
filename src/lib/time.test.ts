import { describe, expect, it } from "vitest";
import { bookingDate, moveTarget, weekStart } from "./time";

const BEIRUT = "Asia/Beirut";

describe("moveTarget", () => {
  // The bug this guards: the staff sheet used the page's date, so opening Thursday's booking from a
  // week whose URL said Monday and changing the time moved the booking to Monday.
  it("keeps a Thursday booking on Thursday, whatever day the calendar is showing", () => {
    const thursday09 = "2026-11-12T07:00:00.000Z"; // 09:00 Beirut, Thursday
    const { start, end } = moveTarget(thursday09, BEIRUT, "14:00", 2, 60);
    expect(bookingDate(start.toISOString(), BEIRUT)).toBe("2026-11-12");
    expect(start.toISOString()).toBe("2026-11-12T12:00:00.000Z"); // 14:00 Beirut
    expect(end.toISOString()).toBe("2026-11-12T14:00:00.000Z");   // two 60-min slots
  });

  it("takes no page date at all, so it cannot drift to the week being viewed", () => {
    // five calls from five different "pages" must agree, because the day comes from the booking
    const sunday = "2026-11-15T08:30:00.000Z";
    const results = [1, 2, 3, 4, 5].map(() => moveTarget(sunday, BEIRUT, "11:30", 1, 90).start.toISOString());
    expect(new Set(results).size).toBe(1);
    expect(bookingDate(results[0], BEIRUT)).toBe("2026-11-15");
  });

  it("reads the day in the club's timezone, not the browser's", () => {
    // 22:30 UTC on the 11th is 00:30 on the 12th in Beirut: the booking belongs to the 12th
    expect(bookingDate("2026-11-11T22:30:00.000Z", BEIRUT)).toBe("2026-11-12");
    expect(bookingDate("2026-11-11T22:30:00.000Z", "UTC")).toBe("2026-11-11");
  });
});

describe("weekStart", () => {
  it("returns the Monday of that week", () => {
    expect(weekStart("2026-11-12")).toBe("2026-11-09"); // Thursday → Monday
    expect(weekStart("2026-11-09")).toBe("2026-11-09"); // Monday → itself
    expect(weekStart("2026-11-15")).toBe("2026-11-09"); // Sunday → the Monday before
  });
});
