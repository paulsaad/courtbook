// @vitest-environment jsdom
/**
 * R1 (Session B's release validation; Paul 26 Nov: should-fix before the desk-only pilot; staff must not be left
 * uncertain whether it succeeded). A desk action whose answer is lost used to leave the grid unchanged with
 * "Something went wrong. Refresh and try again.", and the retry then said "That slot was just taken." (the desk's own
 * walk-in) or "This booking is no longer active." with the cancel still offered. Now, after any failure, the day is
 * read again and the action's own result is looked for: if it is there, it is shown as done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));

type Q = { table: string; filters: Record<string, unknown>; single: boolean };
const db = vi.hoisted(() => ({
  day: [] as unknown[],                       // what the day read returns
  found: null as null | boolean | "fail",     // what a landed check finds
  checks: [] as Record<string, unknown>[],    // the landed checks made (their filters)
  dayReads: 0,
  rpc: [] as { data: unknown; error: { message: string; code?: string } | null }[],
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const q: Q = { table, filters: {}, single: false };
      const b: Record<string, unknown> = {};
      for (const m of ["or", "not", "lt", "gt", "order", "insert", "delete"]) b[m] = () => b;
      b.select = (cols: string) => { q.filters.select = cols; return b; };
      b.eq = (c: string, v: unknown) => { q.filters[c] = v; return b; };
      b.in = (c: string, v: unknown) => { q.filters[c] = v; return b; };
      b.maybeSingle = async () => {
        db.checks.push({ table, ...q.filters });
        if (db.found === "fail") return { data: null, error: { message: "TypeError: Failed to fetch" } };
        return { data: db.found ? { id: "x" } : null, error: null };
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (table === "bookings" && q.filters.select && String(q.filters.select).includes("guest_name")) db.dayReads++;
        return Promise.resolve({ data: table === "bookings" ? db.day : [], error: null }).then(res, rej);
      };
      return b;
    },
    rpc: async (fn: string) => (["staff_book", "staff_block", "cancel_booking", "move_booking_priced", "mark_no_show"].includes(fn)
      ? db.rpc.shift() ?? { data: null, error: null } : { data: [], error: null }),
    auth: { getUser: async () => ({ data: { user: { id: "staff-1" } } }) },
  }),
}));

import DayCalendar from "./DayCalendar";
import { DESK_NOT_SAVED, DESK_UNCHECKED } from "./landed";
import type { Block, Booking, Club, Court } from "@/lib/types";

const club: Club = { id: "club-1", name: "Batroun", slug: "batroun", timezone: "Asia/Beirut", slot_minutes: 30, cancel_cutoff_hours: 6, open_time: "08:00", close_time: "23:00", min_booking_minutes: 60, max_booking_minutes: 180 };
const courtA: Court = { id: "court-a", name: "Padel 1", sport: "padel", surface: null, sort: 1, active: true };
const lost = { data: null, error: { message: "TypeError: Failed to fetch" } };
const walkIn = (name: string, start = "2026-11-12T08:00:00.000Z", end = "2026-11-12T09:00:00.000Z"): Booking => ({
  id: "w-" + name, court_id: courtA.id, player_id: null, guest_name: name, guest_phone: null, start_at: start, end_at: end,
  status: "confirmed", source: "staff", credit_tx_id: null, price_usd: 20, fee_usd: 0,
});
const view = (bookings: Booking[] = []) => render(
  <DayCalendar club={club} courts={[courtA]} bookings={bookings} blocks={[] as Block[]} date="2026-11-12" view="grid" sport={null} court={null} sportNames={{ padel: "Padel" }} />,
);
async function addWalkIn(name: string) {
  await act(async () => { screen.getByRole("button", { name: /^Add booking Padel 1 10:00/ }).click(); });
  fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: name } });
  await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
}
const sheetOpen = () => screen.queryByLabelText("Customer name") !== null || screen.queryByRole("button", { name: "Confirm cancellation" }) !== null;

beforeEach(() => { db.day = []; db.found = null; db.checks = []; db.dayReads = 0; db.rpc = []; });
afterEach(cleanup);

describe("desk: a lost answer is resolved by reading what was saved (R1)", () => {
  it("(a) Add booking whose answer is lost but which was saved: shown as done; the grid shows the walk-in; no 'taken'", async () => {
    view();
    db.rpc = [lost];
    db.found = true;
    db.day = [walkIn("Walk-in Ali", "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z")];
    await addWalkIn("  Walk-in Ali ");
    await waitFor(() => expect(sheetOpen()).toBe(false));
    expect(screen.queryByText(/taken|went wrong|Couldn't reach/)).toBeNull();
    expect(screen.getAllByText(/Walk-in Ali/).length).toBeGreaterThan(0);
    // the check looked for exactly this desk's walk-in (trimmed name, staff source, that court and time)
    expect(db.checks.at(-1)).toMatchObject({ table: "bookings", court_id: "court-a", start_at: "2026-11-12T08:00:00.000Z", end_at: "2026-11-12T09:00:00.000Z", status: "confirmed", source: "staff", guest_name: "Walk-in Ali" });
  });

  it("(a2) not saved: says so; the retry then refused as taken by the desk's own late save is shown as done", async () => {
    view();
    db.rpc = [lost];
    db.found = false;
    await addWalkIn("Walk-in Ali");
    expect(await screen.findByText(DESK_NOT_SAVED)).toBeTruthy();
    expect(sheetOpen()).toBe(true);
    db.rpc = [{ data: null, error: { message: "slot_taken" } }];
    db.found = true;
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(sheetOpen()).toBe(false));
    expect(screen.queryByText(/taken/)).toBeNull();
  });

  it("(b) Confirm cancellation whose answer is lost but which was saved: the sheet closes; cancel is not offered again", async () => {
    const b = walkIn("Rana Khoury");
    view([b]);
    await act(async () => { screen.getAllByRole("button", { name: /Rana Khoury/ })[0].click(); });
    await act(async () => { screen.getByRole("button", { name: "Cancel booking" }).click(); });
    db.rpc = [lost];
    db.found = true;
    db.day = [];
    await act(async () => { screen.getByRole("button", { name: "Confirm cancellation" }).click(); });
    await waitFor(() => expect(sheetOpen()).toBe(false));
    expect(screen.queryByText(/no longer active|went wrong/)).toBeNull();
    expect(db.checks.at(-1)).toMatchObject({ table: "bookings", id: b.id, status: "cancelled" });
  });

  it("(b2) the retried cancel refused as 'no longer active' because the first one was saved: shown as done", async () => {
    view([walkIn("Rana Khoury")]);
    await act(async () => { screen.getAllByRole("button", { name: /Rana Khoury/ })[0].click(); });
    await act(async () => { screen.getByRole("button", { name: "Cancel booking" }).click(); });
    db.rpc = [{ data: null, error: { message: "not_confirmed" } }];
    db.found = true;
    await act(async () => { screen.getByRole("button", { name: "Confirm cancellation" }).click(); });
    await waitFor(() => expect(sheetOpen()).toBe(false));
    expect(screen.queryByText(/no longer active/)).toBeNull();
  });

  it("(c) a genuine slot_taken by someone else: the grid is read again and shows them; the refusal stays", async () => {
    view();
    db.rpc = [{ data: null, error: { message: "slot_taken" } }];
    db.found = false;
    db.day = [walkIn("Other Player")];
    const before = db.dayReads;
    await addWalkIn("Walk-in Ali");
    expect(await screen.findByText("That slot was just taken.")).toBeTruthy();
    expect(db.dayReads).toBeGreaterThan(before);
    expect(screen.getAllByText(/Other Player/).length).toBeGreaterThan(0);
    expect(sheetOpen()).toBe(true);
  });

  it("no answer and the check can't be made either: says it may have been saved and to check before trying again", async () => {
    view();
    db.rpc = [lost];
    db.found = "fail";
    await addWalkIn("Walk-in Ali");
    expect(await screen.findByText(DESK_UNCHECKED)).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });
});
