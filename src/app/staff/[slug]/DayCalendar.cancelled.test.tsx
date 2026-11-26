// @vitest-environment jsdom
/**
 * F3 (Paul, 26 Nov): the staff List view shows the day's cancelled bookings, greyed and labelled "Cancelled", with
 * their original court and time and when they were cancelled; the name only (no phone). They never occupy the Courts
 * grid, never count as busy, and are read only for the List view, only for this club.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { act } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));

const db = vi.hoisted(() => ({
  active: [] as unknown[],
  cancelled: [] as unknown[],
  cancelledFails: false,
  contacts: [] as { booking_id: string; name: string | null; phone: string | null }[],
  reads: [] as Record<string, unknown>[],          // every bookings read: its filters
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = { table };
      const b: Record<string, unknown> = {};
      for (const m of ["or", "lt", "gt", "order", "insert", "delete"]) b[m] = () => b;
      b.not = (c: string) => { filters[`not ${c}`] = true; return b; };
      b.select = (cols: string) => { filters.select = cols; return b; };
      b.eq = (c: string, v: unknown) => { filters[c] = v; return b; };
      b.in = (c: string, v: unknown) => { filters[c] = v; return b; };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (table !== "bookings") return Promise.resolve({ data: [], error: null }).then(res, rej);
        db.reads.push({ ...filters });
        if (filters.status === "cancelled") {
          if (db.cancelledFails) return Promise.resolve({ data: null, error: { message: "TypeError: Failed to fetch" } }).then(res, rej);
          return Promise.resolve({ data: db.cancelled, error: null }).then(res, rej);
        }
        return Promise.resolve({ data: db.active, error: null }).then(res, rej);
      };
      return b;
    },
    rpc: async (fn: string) => {
      if (fn === "club_booking_contacts") return { data: db.contacts, error: null };
      return { data: [], error: null };
    },
    auth: { getUser: async () => ({ data: { user: { id: "staff-maya" } } }) },
  }),
}));

import DayCalendar, { cancelledWhen } from "./DayCalendar";
import type { Block, Booking, Club, Court } from "@/lib/types";

const club: Club = { id: "club-1", name: "Batroun", slug: "batroun", timezone: "Asia/Beirut", slot_minutes: 30, cancel_cutoff_hours: 6, open_time: "08:00", close_time: "23:00", min_booking_minutes: 60, max_booking_minutes: 180 };
const p1: Court = { id: "court-1", name: "Padel 1", sport: "padel", surface: null, sort: 1, active: true };
const t1: Court = { id: "court-t", name: "Tennis 1", sport: "tennis", surface: null, sort: 2, active: true };
const DATE = "2099-01-12";   // Beirut UTC+2
const walkIn: Booking = {
  id: "w1", court_id: p1.id, player_id: null, guest_name: "Sami Walk In", guest_phone: "+961 3 111 111",
  start_at: "2099-01-12T14:00:00+00:00", end_at: "2099-01-12T15:00:00+00:00",   // 16:00–17:00
  status: "confirmed", source: "staff", credit_tx_id: null, price_usd: 20, fee_usd: 0,
};
// Rana's app booking, Padel 1 18:00–19:00, cancelled at 14:05 the same day
const ranaCancelled = { id: "c-rana", court_id: p1.id, guest_name: null, start_at: "2099-01-12T16:00:00+00:00", end_at: "2099-01-12T17:00:00+00:00", cancelled_at: "2099-01-12T12:05:00+00:00" };
// a walk-in on Tennis 1 at 09:00, cancelled the day before
const tennisCancelled = { id: "c-ten", court_id: t1.id, guest_name: "Old Walk In", start_at: "2099-01-12T07:00:00+00:00", end_at: "2099-01-12T08:00:00+00:00", cancelled_at: "2099-01-11T18:30:00+00:00" };

const show = (view: "list" | "grid", sport: string | null = null) => render(
  <DayCalendar club={club} courts={[p1, t1]} bookings={db.active as Booking[]} blocks={[] as Block[]} date={DATE} view={view} sport={sport} court={null} sportNames={{ padel: "Padel", tennis: "Tennis" }} />,
);
const rows = () => screen.queryAllByTestId("cancelled-row");
const cancelledReads = () => db.reads.filter((r) => r.status === "cancelled");

beforeEach(() => {
  db.active = [walkIn]; db.cancelled = [ranaCancelled, tennisCancelled]; db.cancelledFails = false; db.reads = [];
  db.contacts = [{ booking_id: "c-rana", name: "Rana Khoury", phone: "+961 70 123 456" }, { booking_id: "c-ten", name: "Old Walk In", phone: "+961 3 999 999" }];
});
afterEach(cleanup);

describe("F3: the List view shows the day's cancelled bookings", () => {
  it("each with its original court and time, labelled Cancelled with when, the name only; greyed; in time order", async () => {
    show("list");
    await waitFor(() => expect(rows()).toHaveLength(2));
    const [ten, rana] = rows();
    expect(rana.textContent).toBe("18:00–19:00Padel 1Rana KhouryCancelled · cancelled at 14:05");
    expect(ten.textContent).toBe("09:00–10:00Tennis 1Old Walk InCancelled · cancelled Sun 11 Jan, 20:30");
    expect(rana.className).toMatch(/text-muted/);
    expect(rana.className).toMatch(/bg-paper/);
    // no phone for a cancelled booking, though the contacts answer carries one
    expect(document.body.textContent).not.toContain("70 123 456");
    expect(document.body.textContent).not.toContain("3 999 999");
    // time order with the active rows: 09:00 cancelled, 16:00 Sami, 18:00 cancelled
    const items = within(screen.getByRole("list")).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items.map((t) => t.slice(0, 11))).toEqual(["09:00–10:00", "16:00–17:00", "18:00–19:00"]);
  });

  it("a cancelled row offers nothing to do: no button, no sheet", async () => {
    show("list");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(rows()[1]).queryByRole("button")).toBeNull();
    await act(async () => { rows()[1].click(); });
    expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
  });

  it("reads only this club's cancelled bookings, without phone, price or payment columns", async () => {
    show("list");
    await waitFor(() => expect(cancelledReads()).toHaveLength(1));
    const r = cancelledReads()[0];
    expect(r.club_id).toBe("club-1");
    expect(String(r.select)).toBe("id, court_id, guest_name, start_at, end_at, cancelled_at");
    expect(String(r.select)).not.toMatch(/phone|price|fee|payment|player_id/);
  });

  it("the sport filter applies to cancelled rows too", async () => {
    show("list", "padel");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].textContent).toContain("Padel 1");
  });

  it("only cancelled bookings that day: 'No active bookings this day.', and the cancelled rows", async () => {
    db.active = [];
    show("list");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByText(/^No active bookings this day\./)).toBeTruthy();
  });

  it("the cancelled read fails: says so; the active bookings are still listed", async () => {
    db.cancelledFails = true;
    show("list");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Couldn't load the day's cancelled bookings. Active bookings above are up to date."));
    expect(screen.getByText("Sami Walk In")).toBeTruthy();
    expect(rows()).toHaveLength(0);
  });

  it("the desktop count stays the day's active bookings and blocks", async () => {
    show("list");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByTestId("list-count").textContent).toMatch(/^1 booking\b/);
  });
});

describe("F3: cancelled bookings never occupy the Courts grid", () => {
  it("the grid makes no cancelled read, shows no cancelled booking, and the cancelled time is free to book", async () => {
    show("grid");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(cancelledReads()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("Rana Khoury");
    expect(screen.getByRole("button", { name: /^Add booking Padel 1 18:00/ })).toBeTruthy();   // free
    expect(screen.queryByRole("button", { name: /^Add booking Padel 1 16:00/ })).toBeNull();   // Sami's
  });
});

describe("cancelledWhen", () => {
  it("same day: the time; another day: the day and time (club time)", () => {
    expect(cancelledWhen("2099-01-12T12:05:00+00:00", DATE, "Asia/Beirut")).toBe("cancelled at 14:05");
    expect(cancelledWhen("2099-01-11T18:30:00+00:00", DATE, "Asia/Beirut")).toBe("cancelled Sun 11 Jan, 20:30");
    expect(cancelledWhen("2099-01-11T22:30:00+00:00", DATE, "Asia/Beirut")).toBe("cancelled at 00:30");   // 00:30 Beirut on the 12th
  });
});
