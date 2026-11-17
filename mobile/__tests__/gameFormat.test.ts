import { boardCard, courtLabel, gameWhen, joinModeLabel, NO_COURT, spots } from "../lib/gameFormat";
import type { OpenGameRow } from "../lib/gameTypes";

const now = new Date("2026-11-17T08:00:00Z"); // Tue 17 Nov, 10:00 Beirut

describe("gameWhen — club time, Beirut days", () => {
  it("today, with an end time", () => {
    expect(gameWhen("2026-11-17T16:00:00Z", "2026-11-17T17:30:00Z", "Asia/Beirut", now)).toEqual({
      day: "Today", time: "18:00–19:30", a11y: "Today, Tuesday 17 November, 18:00 to 19:30",
    });
  });

  it("tomorrow is decided in Beirut: 23:30 UTC on the 17th is 01:30 on the 18th", () => {
    expect(gameWhen("2026-11-17T23:30:00Z", null, "Asia/Beirut", now)).toMatchObject({ day: "Tomorrow", time: "01:30" });
  });

  it("later days read 'Sat 21 Nov'; no end time shows the start only", () => {
    const w = gameWhen("2026-11-21T16:00:00Z", null, "Asia/Beirut", now);
    expect(w).toEqual({ day: "Sat 21 Nov", time: "18:00", a11y: "Saturday 21 November, 18:00" });
  });
});

describe("spots — the organiser takes one place", () => {
  it("counts like the web (joined+1 of needed+1)", () => {
    expect(spots(3, 1)).toEqual({ capacity: 4, filled: 2, open: 2, text: "2 spots left" });
    expect(spots(3, 2).text).toBe("1 spot left");
    expect(spots(3, 3)).toMatchObject({ open: 0, text: "Full" });
  });
  it("never shows more filled than capacity, even if counts race", () => {
    expect(spots(1, 5)).toMatchObject({ capacity: 2, filled: 2, open: 0 });
  });
});

describe("labels", () => {
  it("join mode", () => {
    expect(joinModeLabel("approval")).toBe("Ask to join");
    expect(joinModeLabel("open")).toBe("Join straight away");
  });
  it("P1: a game without a CourtBook booking says so in full", () => {
    expect(NO_COURT).toBe("No court booked through CourtBook");
    expect(courtLabel(null, false)).toBe(NO_COURT);
    expect(courtLabel("Court 2", false)).toBe(NO_COURT); // a name without a booking never implies one
    expect(courtLabel("Court 2", true)).toBe("Court 2");
  });
});

describe("boardCard", () => {
  const row: OpenGameRow = {
    match_id: "m1", club_id: "c1", club_name: "Batroun Padel & Tennis", club_slug: "batroun", town: "Batroun",
    sport: "padel", start_at: "2026-11-21T16:00:00Z", end_at: "2026-11-21T17:30:00Z",
    level_min: 4, level_max: 6, level_legacy: false, my_level: 5, players_needed: 3, joined: 1,
    note: "Friendly doubles", organizer_name: "Rami", join_mode: "approval", i_joined: false, booking_id: "b1", court_name: "Court 2",
  };

  it("reads the card in order for screen readers", () => {
    expect(boardCard(row, now).a11y).toBe(
      "Padel, Saturday 21 November, 18:00 to 19:30, Batroun Padel & Tennis, Batroun, Court 2, Levels 4–6, You're Level 5 · fits, 2 of 4 players, 2 spots left, asks to join"
    );
  });

  it("uses the shared level helpers for range and fit", () => {
    const c = boardCard({ ...row, my_level: 8 }, now);
    expect(c.level).toBe("Levels 4–6");
    expect(c.fit).toEqual({ text: "You're Level 8 · above range", tone: "warn" });
    expect(boardCard({ ...row, level_min: null, level_max: null }, now).level).toBe("All levels welcome");
  });

  it("no booking → no court wording, even if a court name came back", () => {
    expect(boardCard({ ...row, booking_id: null }, now).court).toBe(NO_COURT);
  });
});
