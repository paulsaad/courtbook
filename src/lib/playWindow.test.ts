import { describe, expect, it } from "vitest";
import { playWindowEnd } from "./playWindow";

// H10: Find a game "Today" and "This week" are Beirut calendar days (as the app and spec U6), not 24 h / 7 × 24 h
describe("Find a game date window", () => {
  const thu1419 = new Date("2026-11-26T12:19:00Z");   // Thu 26 Nov 14:19 in Beirut (UTC+2)
  it("Today ends at the coming Beirut midnight, so Friday 10:00 is not 'today'", () => {
    expect(playWindowEnd("today", thu1419)).toBe("2026-11-26T22:00:00.000Z");
    expect(new Date("2026-11-27T08:00:00Z").toISOString() < playWindowEnd("today", thu1419)!).toBe(false);
  });
  it("late in the evening, Today still ends at that midnight (not 24 h later)", () => {
    expect(playWindowEnd("today", new Date("2026-11-26T21:45:00Z"))).toBe("2026-11-26T22:00:00.000Z");
  });
  it("just after Beirut midnight it is the new day (UTC is still the previous date)", () => {
    expect(playWindowEnd("today", new Date("2026-11-26T22:30:00Z"))).toBe("2026-11-27T22:00:00.000Z");
  });
  // "This week" = today and the next 6 Beirut days, exactly as the app (mobile/lib/gameFilters.ts) and the M3 foundation
  // report of 17 Nov. It is a rolling 7 days, not Monday–Sunday (Monday-start weeks are the staff calendar's Week view).
  it("This week is today and the next 6 days (from Thursday: through Wednesday)", () => {
    expect(playWindowEnd("week", thu1419)).toBe("2026-12-02T22:00:00.000Z");
  });
  it("from Sunday it runs through Saturday, not just to the end of that Sunday", () => {
    const sun2330 = new Date("2026-11-29T21:30:00Z");   // Sun 29 Nov 23:30 Beirut
    expect(playWindowEnd("week", sun2330)).toBe("2026-12-05T22:00:00.000Z");   // end of Sat 5 Dec
    expect(playWindowEnd("today", sun2330)).toBe("2026-11-29T22:00:00.000Z");
  });
  it("across the spring clock change (Beirut, last Sunday of March) the day still ends at local midnight", () => {
    expect(playWindowEnd("today", new Date("2027-03-28T10:00:00Z"))).toBe("2027-03-28T21:00:00.000Z");
  });
  it("Any day sends no end (the server's own default, unchanged)", () => {
    expect(playWindowEnd("any", thu1419)).toBeNull();
  });
});
