// @vitest-environment jsdom
/**
 * Paul, 26 Nov: a new booking selection starts at 1 h wherever the club's rules allow it (the app does the same).
 * At a club whose minimum is 30 minutes, tapping a free time used to start at 30 minutes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { formatInTimeZone } from "date-fns-tz";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: 20, error: null }),
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq", "in", "gte", "lt", "gt", "order", "or", "not"]) b[m] = () => b; b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r); return b; },
  }),
}));

import PlayerGrid from "./PlayerGrid";

const TZ = "Asia/Beirut";
const tomorrow = formatInTimeZone(new Date(Date.now() + 24 * 3600_000), TZ, "yyyy-MM-dd");
const club = (min: number) => ({
  id: "c1", name: "Test Club", slug: "test", active: true, timezone: TZ, open_time: "08:00", close_time: "23:00",
  slot_minutes: 30, min_booking_minutes: min, max_booking_minutes: 180, cancel_cutoff_hours: 6, hold_minutes: 10,
  booking_window_days: 14, service_fee_usd: 0, location_url: null, payment_mode: "at_desk", is_demo: false,
}) as never;
const COURTS = [{ id: "k1", club_id: "c1", name: "Court 1", sport: "padel", active: true, sort: 1 }] as never;

Element.prototype.scrollIntoView = function () {};
afterEach(cleanup);

async function tapTen(min: number) {
  const { container } = render(<PlayerGrid signedIn club={club(min)} courts={COURTS} occ={[]} occError={false} date={tomorrow} hold={null} preselect={null} sportNames={{ padel: "Padel" }} />);
  // the grid's half-hour cells from 08:00: the fifth is 10:00
  const ten = container.querySelectorAll<HTMLButtonElement>("button.absolute")[4];
  fireEvent.click(ten);
  return within(screen.getByRole("dialog")).getByRole("heading").textContent ?? "";
}

describe("club page: the length a tapped time starts with", () => {
  it("minimum 30 min: starts at 1 h (10:00–11:00), not 30 min", async () => {
    expect(await tapTen(30)).toContain("10:00–11:00");
  });
  it("minimum 1 h 30: starts at the minimum", async () => {
    expect(await tapTen(90)).toContain("10:00–11:30");
  });
});
