// @vitest-environment jsdom
/**
 * PR-9a: the website offers every length the club allows (whole grid steps, minimum to maximum, the same rule as the
 * app: @/lib/durations), limited only by how long the chosen court is actually free from the chosen time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { formatInTimeZone } from "date-fns-tz";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: 20, error: null }),
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq", "in", "gte", "lt", "gt", "order", "or", "not"]) b[m] = () => b; b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r); return b; },
  }),
}));

import PlayerGrid, { type Occ } from "./PlayerGrid";

const TZ = "Asia/Beirut";
const tomorrow = formatInTimeZone(new Date(Date.now() + 24 * 3600_000), TZ, "yyyy-MM-dd");
const at = (hhmm: string) => new Date(`${tomorrow}T${hhmm}:00+02:00`).toISOString();   // Beirut is UTC+2 in winter

function club(min: number, max: number, slot = 30) {
  return {
    id: "c1", name: "Test Club", slug: "test", active: true, timezone: TZ, open_time: "08:00", close_time: "23:00",
    slot_minutes: slot, min_booking_minutes: min, max_booking_minutes: max, cancel_cutoff_hours: 6, hold_minutes: 10,
    booking_window_days: 14, service_fee_usd: 0, location_url: null, payment_mode: "at_desk", is_demo: false,
  } as never;
}
const COURTS = [{ id: "k1", club_id: "c1", name: "Court 1", sport: "padel", active: true, sort: 1 }] as never;

function lengthsShown(min: number, max: number, occ: Occ[] = [], slot = 30) {
  render(<PlayerGrid signedIn club={club(min, max, slot)} courts={COURTS} occ={occ} occError={false} date={tomorrow} hold={null}
    preselect={{ date: tomorrow, time: "10:00", courtId: "k1", minutes: null }} sportNames={{ padel: "Padel" }} />);
  const dialog = screen.getByRole("dialog");
  return within(dialog).getAllByRole("button").map((b) => b.textContent ?? "").filter((t) => /^(\d+ h( \d+)?|\d+ min)$/.test(t));
}

// jsdom has no layout: the day strip scrolls the chosen day into view
Element.prototype.scrollIntoView = function () {};
afterEach(cleanup);

describe("website booking lengths (PR-9a)", () => {
  it("1 h to 3 h on a 30-min grid: all five, the 3 h maximum included", () => {
    expect(lengthsShown(60, 180)).toEqual(["1 h", "1 h 30", "2 h", "2 h 30", "3 h"]);
  });
  it("more than five lengths are all offered", () => {
    expect(lengthsShown(30, 240)).toEqual(["30 min", "1 h", "1 h 30", "2 h", "2 h 30", "3 h", "3 h 30", "4 h"]);
  });
  it("minimum equal to maximum: only that length", () => {
    expect(lengthsShown(90, 90)).toEqual(["1 h 30"]);
  });
  it("a minimum off the grid starts at the next whole step, as the app does", () => {
    expect(lengthsShown(75, 180)).toEqual(["1 h 30", "2 h", "2 h 30", "3 h"]);
  });
  it("the court is booked at 12:00: only lengths that end by then", () => {
    const occ: Occ[] = [{ court_id: "k1", start_at: at("12:00"), end_at: at("13:00"), status: "confirmed", kind: "booking" }];
    expect(lengthsShown(60, 180, occ)).toEqual(["1 h", "1 h 30", "2 h"]);
  });
});
