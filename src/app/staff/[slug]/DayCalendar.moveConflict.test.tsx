// @vitest-environment jsdom
/**
 * F1 (Paul, 26 Nov): two desks must not unknowingly overwrite each other's moves. The calendar sends the court and time
 * the booking sheet was OPENED with; the database moves the booking only if it is still there. A refused move reloads
 * the day, reads the booking again and says what changed. Reproduction 3 of the operations audit, in the calendar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));

type Err = { message: string; code?: string } | null;
const db = vi.hoisted(() => ({
  day: [] as unknown[],                                  // what the day read returns
  current: null as unknown,                              // what reading the one booking again returns
  currentFails: false,
  moves: [] as Record<string, unknown>[],                // every move_booking_priced call, in order
  moveAnswers: [] as { data: unknown; error: Err }[],
  dayReads: 0,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const m of ["or", "not", "lt", "gt", "order", "insert", "delete"]) b[m] = () => b;
      b.select = (cols: string) => { filters.select = cols; return b; };
      b.eq = (c: string, v: unknown) => { filters[c] = v; return b; };
      b.in = (c: string, v: unknown) => { filters[c] = v; return b; };
      b.maybeSingle = async () => {
        if (table !== "bookings") return { data: null, error: null };
        if (db.currentFails) return { data: null, error: { message: "TypeError: Failed to fetch" } };
        // a row is returned only if it matches every filter (R1's landed check filters by court, time and status)
        const row = db.current as Record<string, unknown> | null;
        const match = row && Object.entries(filters).every(([k, v]) => k === "select" || row[k] === v);
        return { data: match ? row : null, error: null };
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (table === "bookings") db.dayReads++;
        return Promise.resolve({ data: table === "bookings" ? db.day : [], error: null }).then(res, rej);
      };
      return b;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "quote_move") return { data: { current: 30, new: 30, kind: "same" }, error: null };
      if (fn === "move_booking_priced") { db.moves.push(args); return db.moveAnswers.shift() ?? { data: { price: 30, kind: "same" }, error: null }; }
      if (fn === "club_booking_contacts") return { data: [], error: null };
      return { data: [], error: null };
    },
    auth: { getUser: async () => ({ data: { user: { id: "staff-maya" } } }) },
  }),
}));

import DayCalendar from "./DayCalendar";
import type { Block, Booking, Club, Court } from "@/lib/types";

const club: Club = { id: "club-1", name: "Batroun", slug: "batroun", timezone: "Asia/Beirut", slot_minutes: 30, cancel_cutoff_hours: 6, open_time: "08:00", close_time: "23:00", min_booking_minutes: 60, max_booking_minutes: 180 };
const p1: Court = { id: "court-1", name: "Padel 1", sport: "padel", surface: null, sort: 1, active: true };
const p2: Court = { id: "court-2", name: "Padel 2", sport: "padel", surface: null, sort: 2, active: true };
const p3: Court = { id: "court-3", name: "Padel 3", sport: "padel", surface: null, sort: 3, active: true };
const DATE = "2099-01-12";   // Beirut is UTC+2 in January: 18:00 = 16:00Z
// Rana's booking, as both desks opened it: Padel 2, 18:00–19:00
const opened: Booking = {
  id: "bk-rana", court_id: p2.id, player_id: null, guest_name: "Rana Khoury", guest_phone: null,
  start_at: "2099-01-12T16:00:00+00:00", end_at: "2099-01-12T17:00:00+00:00",
  status: "confirmed", source: "staff", credit_tx_id: null, price_usd: 30, fee_usd: 0,
};
// …after Dina moved it to Padel 1
const onPadel1: Booking = { ...opened, court_id: p1.id };

const view = () => render(
  <DayCalendar club={club} courts={[p1, p2, p3]} bookings={[opened]} blocks={[] as Block[]} date={DATE} view="grid" sport={null} court={null} sportNames={{ padel: "Padel" }} />,
);
/** Maya: tap the booking → Move → Padel 3 → Save move */
async function mayaMovesToPadel3() {
  await act(async () => { screen.getAllByRole("button", { name: /Rana Khoury/ })[0].click(); });
  await act(async () => { screen.getByRole("button", { name: "Move" }).click(); });
  fireEvent.change(screen.getByDisplayValue("Padel 2"), { target: { value: p3.id } });
  await waitFor(() => expect(screen.getByText("Price unchanged: $30.00")).toBeTruthy());
  await act(async () => { (screen.getByRole("button", { name: /^Save move/ }) as HTMLButtonElement).click(); });
}
const sheetText = () => document.querySelector("[role=dialog]")?.textContent ?? "";
const page = () => document.body.textContent ?? "";

beforeEach(() => { db.day = [opened]; db.current = null; db.currentFails = false; db.moves = []; db.moveAnswers = []; db.dayReads = 0; });
afterEach(cleanup);

describe("F1: a move carries what the sheet was opened with", () => {
  it("sends the court and time the sheet showed, and a fresh view saves as before", async () => {
    view();
    await mayaMovesToPadel3();
    expect(db.moves).toHaveLength(1);
    expect(db.moves[0]).toMatchObject({
      p_booking: "bk-rana", p_court: p3.id, p_expected_price: 30,
      p_seen_court: p2.id, p_seen_start: opened.start_at, p_seen_end: opened.end_at,
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Save move/ })).toBeNull());   // saved: the sheet closed
  });

  it("a delayed save after the automatic refresh still sends what the sheet was OPENED with, not the refreshed rows", async () => {
    view();
    await act(async () => { screen.getAllByRole("button", { name: /Rana Khoury/ })[0].click(); });
    await act(async () => { screen.getByRole("button", { name: "Move" }).click(); });
    // meanwhile Dina moved it; this desk's 60-second refresh (here: returning to the tab) reads the day again
    db.day = [onPadel1];
    const reads = db.dayReads;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(db.dayReads).toBeGreaterThan(reads));
    fireEvent.change(screen.getByDisplayValue("Padel 2"), { target: { value: p3.id } });
    await waitFor(() => expect(screen.getByText("Price unchanged: $30.00")).toBeTruthy());
    db.moveAnswers = [{ data: null, error: { message: "booking_changed_elsewhere", code: "P0001" } }];
    db.current = onPadel1;
    await act(async () => { (screen.getByRole("button", { name: /^Save move/ }) as HTMLButtonElement).click(); });
    expect(db.moves[0]).toMatchObject({ p_seen_court: p2.id, p_seen_start: opened.start_at, p_seen_end: opened.end_at });
  });
});

describe("F1: a refused move reloads and says what changed (never 'saved')", () => {
  it("moved to another court elsewhere: the day is read again, the sheet shows where it is now, and says what changed", async () => {
    view();
    db.moveAnswers = [{ data: null, error: { message: "booking_changed_elsewhere", code: "P0001" } }];
    db.day = [onPadel1];
    db.current = onPadel1;
    const reads = db.dayReads;
    await mayaMovesToPadel3();
    expect(db.moves).toHaveLength(1);                                  // not retried, no fallback
    expect(db.dayReads).toBeGreaterThan(reads);                        // the day was read again
    await waitFor(() => expect(sheetText()).toContain(
      "This booking was changed on another screen: it is now on Padel 1, 18:00–19:00 (you opened it on Padel 2, 18:00–19:00). Your move was not saved. Check it before moving it again."));
    // the sheet now shows the booking where it is, back in its first view
    expect(sheetText()).toMatch(/Padel 1, Mon 12 Jan, 18:00–19:00/);
    expect(screen.getByRole("button", { name: "Move" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save move/ })).toBeNull();
    expect(page()).not.toMatch(/\bSaved\b/);
  });

  it("moved to another day elsewhere: the message names both days", async () => {
    view();
    const nextDay = { ...opened, start_at: "2099-01-13T16:00:00+00:00", end_at: "2099-01-13T17:00:00+00:00" };
    db.moveAnswers = [{ data: null, error: { message: "booking_changed_elsewhere", code: "P0001" } }];
    db.current = nextDay;
    db.day = [];
    await mayaMovesToPadel3();
    await waitFor(() => expect(sheetText()).toContain("it is now on Padel 2, Tue 13 Jan 18:00–19:00 (you opened it on Padel 2, Mon 12 Jan 18:00–19:00)"));
  });

  it("cancelled elsewhere while the sheet was open (not_confirmed): the sheet closes and the calendar says so", async () => {
    view();
    db.moveAnswers = [{ data: null, error: { message: "not_confirmed", code: "P0001" } }];
    db.current = { ...opened, status: "cancelled" };
    db.day = [];
    await mayaMovesToPadel3();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("This booking was cancelled on another screen, so your move was not saved."));
    expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm cancellation" })).toBeNull();
  });

  it("refused, and the booking cannot be read again: says it changed and to check the calendar; the sheet closes", async () => {
    view();
    db.moveAnswers = [{ data: null, error: { message: "booking_changed_elsewhere", code: "P0001" } }];
    db.currentFails = true;
    await mayaMovesToPadel3();
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(
      /^This booking was changed on another screen, so your move was not saved\. Check the calendar before moving it again\.(OK)?$/));
    expect(screen.queryByRole("button", { name: /^Save move/ })).toBeNull();
  });

  it("other refusals keep their own words (slot taken): the sheet stays on the move", async () => {
    view();
    db.moveAnswers = [{ data: null, error: { message: "slot_taken", code: "P0001" } }];
    await mayaMovesToPadel3();
    await waitFor(() => expect(sheetText()).toContain("That slot was just taken."));
    expect(screen.getByRole("button", { name: /^Save move/ })).toBeTruthy();
  });
});

describe("F1 rollout: before the database change, the page uses 0091's call", () => {
  it("PGRST202 (no function with these arguments): the same move is sent once more without the seen values", async () => {
    view();
    db.moveAnswers = [{ data: null, error: { message: "Could not find the function public.move_booking_priced(...) in the schema cache", code: "PGRST202" } }];
    await mayaMovesToPadel3();
    expect(db.moves).toHaveLength(2);
    expect(db.moves[1]).toEqual({ p_booking: "bk-rana", p_court: p3.id, p_start: db.moves[0].p_start, p_end: db.moves[0].p_end, p_expected_price: 30 });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Save move/ })).toBeNull());
  });
  it("any other error is never retried with 0091's call", async () => {
    view();
    db.moveAnswers = [{ data: null, error: { message: "move_needs_reload", code: "P0001" } }];
    await mayaMovesToPadel3();
    expect(db.moves).toHaveLength(1);
  });
});
