import { clubsFromSlots, durationLabel, durationOptions, tilesFor, type DaySlot } from "../lib/courts";

const base = {
  club_id: "c1", club_name: "Sample Padel", slug: "sample", town: "Batroun", district: null, price_from: 20, sports: ["padel"],
  slot_minutes: 30, min_minutes: 60, max_minutes: 120, service_fee_usd: 1, hold_minutes: 10, cancel_cutoff_hours: 6,
  timezone: "Asia/Beirut", court_sport: "padel", is_demo: false,
};
const row = (court: string, at: string, free: number, extra: Partial<DaySlot> = {}): DaySlot =>
  ({ ...base, court_id: court, court_name: court === "k1" ? "Court 1" : court === "k2" ? "Court 2" : "Court 10", start_at: at, free_minutes: free, ...extra });

const T = (hhmm: string) => `2026-11-14T${hhmm}:00.000Z`;

describe("clubsFromSlots", () => {
  it("groups by club, counts courts, lists distinct free starts in order", () => {
    const clubs = clubsFromSlots([row("k2", T("17:00"), 120), row("k1", T("16:00"), 60), row("k1", T("17:00"), 90)]);
    expect(clubs).toHaveLength(1);
    expect(clubs[0]).toMatchObject({ courtCount: 2, starts: [T("16:00"), T("17:00")], priceFrom: 20 });
  });

  it("ignores starts shorter than the club's minimum booking", () => {
    expect(clubsFromSlots([row("k1", T("16:00"), 30)])[0].starts).toEqual([]);
  });

  it("puts clubs with free times first, earliest first", () => {
    const clubs = clubsFromSlots([
      row("k1", T("19:00"), 60, { club_id: "late", club_name: "Late" }),
      row("k1", T("16:00"), 30, { club_id: "none", club_name: "None" }),
      row("k1", T("15:00"), 60, { club_id: "early", club_name: "Early" }),
    ]);
    expect(clubs.map((c) => c.id)).toEqual(["early", "late", "none"]);
  });
});

describe("tilesFor", () => {
  const rows = [row("k1", T("16:00"), 120), row("k2", T("16:00"), 60), row("k1", T("17:00"), 60), row("k10", T("16:00"), 90)];

  it("counts a court only if it stays free for the whole duration", () => {
    const t60 = tilesFor(rows, "c1", 60), t90 = tilesFor(rows, "c1", 90), t120 = tilesFor(rows, "c1", 120);
    expect(t60[0].freeCourts.map((c) => c.name)).toEqual(["Court 1", "Court 2", "Court 10"]);
    expect(t90[0].freeCourts.map((c) => c.name)).toEqual(["Court 1", "Court 10"]);
    expect(t120[0].freeCourts.map((c) => c.name)).toEqual(["Court 1"]);
  });

  it("fills the gaps between free starts as not-free tiles, on the club's grid", () => {
    const tiles = tilesFor(rows, "c1", 60);
    expect(tiles.map((t) => [t.start, t.freeCourts.length])).toEqual([[T("16:00"), 3], [T("16:30"), 0], [T("17:00"), 1]]);
  });

  it("is empty for a club with nothing", () => {
    expect(tilesFor(rows, "other", 60)).toEqual([]);
  });
});

describe("durations", () => {
  it("offers min..max in slot steps", () => {
    expect(durationOptions({ slotMinutes: 30, minMinutes: 60, maxMinutes: 120 })).toEqual([60, 90, 120]);
  });
  it("labels them as people say them", () => {
    expect([30, 60, 90, 120].map(durationLabel)).toEqual(["30 min", "1 h", "1 h 30", "2 h"]);
  });
});
