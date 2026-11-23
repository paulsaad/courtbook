import { describe, expect, it } from "vitest";
import { bookingDate, clubLocalToUtc, dayBounds, moveTarget, weekStart } from "./time";

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

describe("0084: the spring clock-change night in Beirut (local midnight does not exist)", () => {
  // 27→28 Mar 2027: at 00:00 the clocks jump to 01:00, so Sunday starts at 22:00Z (not 21:00Z)
  it("the Saturday's day ends at the first real instant of Sunday", () => {
    expect(dayBounds("2027-03-27", "Asia/Beirut")).toEqual({ dayStart: "2027-03-26T22:00:00.000Z", dayEnd: "2027-03-27T22:00:00.000Z" });
  });
  it("the Sunday starts there too, not an hour early inside Saturday", () => {
    expect(dayBounds("2027-03-28", "Asia/Beirut").dayStart).toBe("2027-03-27T22:00:00.000Z");
  });
  it("closing time 24:00 that night is the same instant", () => {
    expect(clubLocalToUtc("2027-03-27", "24:00", "Asia/Beirut").toISOString()).toBe("2027-03-27T22:00:00.000Z");
  });
  it("ordinary days are unchanged", () => {
    expect(dayBounds("2026-12-01", "Asia/Beirut")).toEqual({ dayStart: "2026-11-30T22:00:00.000Z", dayEnd: "2026-12-01T22:00:00.000Z" });
    expect(clubLocalToUtc("2026-12-01", "24:00", "Asia/Beirut").toISOString()).toBe("2026-12-01T22:00:00.000Z");
  });
  it("the autumn night keeps its 25-hour day", () => {
    const { dayStart, dayEnd } = dayBounds("2026-10-24", "Asia/Beirut");
    expect((Date.parse(dayEnd) - Date.parse(dayStart)) / 3_600_000).toBe(25);
  });
});
