jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
import { cancellation, splitAgenda, type AgendaRow } from "../lib/bookings";

const row = (id: string, start: string, end: string, status = "confirmed", kind: AgendaRow["kind"] = "booking"): AgendaRow => ({
  kind, id, start_at: start, end_at: end, club_name: "Club", club_slug: "club", timezone: "Asia/Beirut", title: "Court 1", status, role: "player",
});

describe("cancellation", () => {
  const start = "2026-11-15T16:00:00+00:00";
  it("is free until cutoff hours before the start, as cancel_booking decides", () => {
    const { cutoffAt, free } = cancellation(start, 6, Date.parse("2026-11-15T09:59:00Z"));
    expect(cutoffAt.toISOString()).toBe("2026-11-15T10:00:00.000Z");
    expect(free).toBe(true);
  });
  it("is not free at or after the cutoff", () => {
    expect(cancellation(start, 6, Date.parse("2026-11-15T10:00:00Z")).free).toBe(false);
    expect(cancellation(start, 6, Date.parse("2026-11-15T15:00:00Z")).free).toBe(false);
  });
});

describe("splitAgenda", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  it("puts upcoming soonest first and everything else under past, newest first", () => {
    const rows = [
      row("later", "2026-11-20T16:00:00+00:00", "2026-11-20T17:30:00+00:00"),
      row("soon", "2026-11-15T16:00:00+00:00", "2026-11-15T17:30:00+00:00"),
      row("playing-now", "2026-11-14T11:30:00+00:00", "2026-11-14T13:00:00+00:00"),
      row("cancelled-future", "2026-11-18T16:00:00+00:00", "2026-11-18T17:30:00+00:00", "cancelled"),
      row("old", "2026-11-01T16:00:00+00:00", "2026-11-01T17:30:00+00:00"),
      row("older", "2026-10-01T16:00:00+00:00", "2026-10-01T17:30:00+00:00", "no_show"),
    ];
    const { upcoming, past } = splitAgenda(rows, now);
    expect(upcoming.map((r) => r.id)).toEqual(["playing-now", "soon", "later"]);
    expect(past.map((r) => r.id)).toEqual(["cancelled-future", "old", "older"]);
  });
});
