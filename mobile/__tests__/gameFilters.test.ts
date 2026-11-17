import { activeFilterCount, ANY_TIME_DAYS, BOARD_LIMIT, capNote, DEFAULT_FILTERS, localDate, myLevelNote, toOpenMatchesParams, type GameFilters } from "../lib/gameFilters";

// Test plan U6 — filters → open_matches parameters, with Beirut calendar-day boundaries.
// Lebanon: UTC+2 in winter, UTC+3 in summer; summer time ended on Sun 25 Oct 2026.
const f = (over: Partial<GameFilters> = {}): GameFilters => ({ ...DEFAULT_FILTERS, ...over });

describe("toOpenMatchesParams — date windows end at a Beirut midnight", () => {
  it("today ends at the coming Beirut midnight, not 24 h from now", () => {
    const now = new Date("2026-11-17T08:00:00Z"); // 10:00 Beirut
    expect(toOpenMatchesParams(f({ when: "today" }), now).p_to).toBe("2026-11-17T22:00:00.000Z");
  });

  it("one minute before Beirut midnight still counts as the same day", () => {
    const now = new Date("2026-11-17T21:59:00Z"); // 23:59 Beirut, 17 Nov
    expect(localDate(now)).toBe("2026-11-17");
    expect(toOpenMatchesParams(f({ when: "today" }), now).p_to).toBe("2026-11-17T22:00:00.000Z");
  });

  it("one minute after Beirut midnight is already the next day, although UTC is still the 17th", () => {
    const now = new Date("2026-11-17T22:01:00Z"); // 00:01 Beirut, 18 Nov
    expect(localDate(now)).toBe("2026-11-18");
    expect(toOpenMatchesParams(f({ when: "today" }), now).p_to).toBe("2026-11-18T22:00:00.000Z");
  });

  it("this week = today and the next 6 Beirut days", () => {
    const now = new Date("2026-11-17T08:00:00Z");
    expect(toOpenMatchesParams(f({ when: "week" }), now).p_to).toBe("2026-11-23T22:00:00.000Z");
  });

  it("summer time: a Beirut day ends at 21:00 UTC (UTC+3)", () => {
    const now = new Date("2026-10-23T09:00:00Z"); // Fri 23 Oct, 12:00 Beirut
    expect(toOpenMatchesParams(f({ when: "today" }), now).p_to).toBe("2026-10-23T21:00:00.000Z");
  });

  it("the day summer time ends has 25 hours: it ends at 22:00 UTC, and the week after it at UTC+2", () => {
    // Beirut clocks go back at midnight between Sat 24 and Sun 25 Oct 2026 (21:00 UTC), so Saturday's
    // midnight falls an hour later in UTC than Friday's.
    const now = new Date("2026-10-24T09:00:00Z"); // Sat 24 Oct, 12:00 Beirut (UTC+3)
    expect(toOpenMatchesParams(f({ when: "today" }), now).p_to).toBe("2026-10-24T22:00:00.000Z");
    expect(toOpenMatchesParams(f({ when: "week" }), now).p_to).toBe("2026-10-30T22:00:00.000Z");
  });

  it("any time looks ahead the posting horizon in Beirut days", () => {
    const now = new Date("2026-11-17T08:00:00Z");
    const to = new Date(toOpenMatchesParams(f({ when: "any" }), now).p_to);
    expect(ANY_TIME_DAYS).toBe(60);
    expect(to.toISOString()).toBe("2027-01-15T22:00:00.000Z"); // end of 15 Jan = 17 Nov + 59 days
  });

  it("never sends p_from, so the server's own 'not started' rule applies", () => {
    expect(toOpenMatchesParams(f(), new Date()).p_from).toBeNull();
  });
});

describe("toOpenMatchesParams — other filters", () => {
  const now = new Date("2026-11-17T08:00:00Z");

  it("defaults: all sports, any level, everywhere, the server cap", () => {
    const p = toOpenMatchesParams(DEFAULT_FILTERS, now);
    expect(p).toMatchObject({ p_sport: null, p_fit: null, p_governorate: null, p_district: null, p_limit: BOARD_LIMIT });
    expect(BOARD_LIMIT).toBe(100);
  });

  it("sport and My level map to p_sport and p_fit='mine'", () => {
    expect(toOpenMatchesParams(f({ sport: "padel", myLevel: true }), now)).toMatchObject({ p_sport: "padel", p_fit: "mine" });
  });

  it("a district is sent alone; a governorate alone when no district is chosen", () => {
    expect(toOpenMatchesParams(f({ governorate: "north", district: "batroun" }), now)).toMatchObject({ p_governorate: null, p_district: "batroun" });
    expect(toOpenMatchesParams(f({ governorate: "north" }), now)).toMatchObject({ p_governorate: "north", p_district: null });
  });
});

describe("filter chrome", () => {
  it("counts filters that differ from the defaults", () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(activeFilterCount(f({ sport: "tennis", when: "today", myLevel: true, district: "batroun" }))).toBe(4);
  });

  it("My level without a level for the sport explains itself (the server then returns every level)", () => {
    expect(myLevelNote(f({ myLevel: true, sport: "padel" }), {})).toBe("Set your level to filter by it");
    expect(myLevelNote(f({ myLevel: true, sport: "padel" }), { padel: 5 })).toBeNull();
    expect(myLevelNote(f({ myLevel: true }), {})).toBe("Set your level to filter by it");
    expect(myLevelNote(f({ myLevel: false }), {})).toBeNull();
  });

  it("says so when the server cap was reached", () => {
    expect(capNote(99)).toBeNull();
    expect(capNote(100)).toBe("Showing the next 100 games. Narrow the dates to see more.");
  });
});
