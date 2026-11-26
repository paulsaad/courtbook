// @vitest-environment jsdom
/**
 * R1 (Session B's release validation; Paul 26 Nov: should-fix before the desk-only pilot). A desk action whose answer is
 * lost used to leave the grid unchanged with "Something went wrong. Refresh and try again.", and the retry then said
 * "That slot was just taken." (the desk's own walk-in) or "This booking is no longer active." with cancel still offered.
 * Now, after any failure, the day is read again and the action's result is looked for. Paul's review of #98:
 *  A. a matching result may be another staff member's doing the same thing: the desk is shown what the calendar now
 *     holds, and is never told that this request succeeded;
 *  B. no match after no answer is not proof it will never be saved: never "not saved".
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
  dayFail: false,
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
        if (db.dayFail) return Promise.resolve({ data: null, error: { message: "TypeError: Failed to fetch" } }).then(res, rej);
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
import { DESK_UNCONFIRMED, DESK_UNREACHABLE } from "./landed";
import type { Block, Booking, Club, Court } from "@/lib/types";

const club: Club = { id: "club-1", name: "Batroun", slug: "batroun", timezone: "Asia/Beirut", slot_minutes: 30, cancel_cutoff_hours: 6, open_time: "08:00", close_time: "23:00", min_booking_minutes: 60, max_booking_minutes: 180 };
const courtA: Court = { id: "court-a", name: "Padel 1", sport: "padel", surface: null, sort: 1, active: true };
const lost = { data: null, error: { message: "TypeError: Failed to fetch" } };
const walkIn = (name: string, start = "2026-11-12T08:00:00.000Z", end = "2026-11-12T09:00:00.000Z"): Booking => ({
  id: "w-" + name, court_id: courtA.id, player_id: null, guest_name: name, guest_phone: null, start_at: start, end_at: end,
  status: "confirmed", source: "staff", credit_tx_id: null, price_usd: 20, fee_usd: 0,
});
const view = (bookings: Booking[] = [], date = "2026-11-12") => render(
  <DayCalendar club={club} courts={[courtA]} bookings={bookings} blocks={[] as Block[]} date={date} view="grid" sport={null} court={null} sportNames={{ padel: "Padel" }} />,
);
async function addWalkIn(name: string) {
  await act(async () => { screen.getByRole("button", { name: /^Add booking Padel 1 10:00/ }).click(); });
  fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: name } });
  await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
}
const sheetOpen = () => screen.queryByLabelText("Customer name") !== null || screen.queryByRole("button", { name: "Confirm cancellation" }) !== null;

beforeEach(() => { db.day = []; db.found = null; db.checks = []; db.dayReads = 0; db.rpc = []; db.dayFail = false; });
afterEach(cleanup);

const notice = () => screen.queryByRole("status")?.textContent ?? null;
/** never a confident claim about this request: not "saved", not "not saved" */
const noFalseCertainty = () => {
  // the messages only (the legend has its own "not saved" label for an unsaved draft)
  const messages = [...document.querySelectorAll("p, span, [role=status]")].map((e) => e.textContent ?? "").filter((t) => /Couldn't|Saved/.test(t));
  for (const m of messages) expect(m).not.toMatch(/not saved|^Saved\.|(?<!whether )this was saved|it was saved/i);
};

describe("desk: a lost answer is resolved by reading the calendar (R1, with Paul's corrections A and B)", () => {
  it("(a) Add booking whose answer is lost, matching walk-in found: the grid shows it; the desk is told what the calendar shows, not that it saved", async () => {
    view();
    db.rpc = [lost];
    db.found = true;
    db.day = [walkIn("Walk-in Ali", "2026-11-12T08:00:00.000Z", "2026-11-12T09:00:00.000Z")];
    await addWalkIn("  Walk-in Ali ");
    await waitFor(() => expect(sheetOpen()).toBe(false));
    expect(notice()).toContain("Couldn't confirm this request, but the calendar now shows a booking for Walk-in Ali on Padel 1 at 10:00.");
    expect(screen.queryByText(/taken|went wrong/)).toBeNull();
    expect(screen.getAllByText(/Walk-in Ali/).length).toBeGreaterThan(0);
    noFalseCertainty();
    expect(db.checks.at(-1)).toMatchObject({ table: "bookings", court_id: "court-a", start_at: "2026-11-12T08:00:00.000Z", end_at: "2026-11-12T09:00:00.000Z", status: "confirmed", source: "staff", guest_name: "Walk-in Ali" });
  });

  it("(A1) two desks enter the same walk-in; the other desk's was saved and this one is refused: the calendar's booking is shown, never as this desk's success", async () => {
    view();
    await act(async () => { screen.getByRole("button", { name: /^Add booking Padel 1 10:00/ }).click(); });
    fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Walk-in Ali" } });
    db.rpc = [{ data: null, error: { message: "slot_taken" } }];
    db.found = true;     // Maya's identical walk-in, saved first
    db.dayFail = true;   // and the calendar's re-reads fail from here on
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(notice()).toContain("Couldn't confirm this request, but the calendar now shows a booking for Walk-in Ali"));
    // not recorded as this desk's save: the out-of-date banner never begins "Saved." (it does after a real save)
    await waitFor(() => expect(screen.getByText(/Couldn't load the latest/)).toBeTruthy());
    expect(screen.getByText(/Couldn't load the latest/).textContent).not.toMatch(/^Saved\./);
    noFalseCertainty();
  });

  it("(A2) two desks block the same time; this desk's answer is lost and a matching block exists: shown as what the calendar holds", async () => {
    view([], "2027-01-14");   // a future day: block times are offered
    await act(async () => { screen.getByRole("button", { name: /^Add booking Padel 1 10:00/ }).click(); });
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    db.rpc = [lost];
    db.found = true;
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
    await waitFor(() => expect(notice() ?? "").toMatch(/^Couldn't confirm this request, but the calendar now shows a block on Padel 1 from 10:00 to /));
    expect(db.checks.at(-1)).toMatchObject({ table: "blocks", court_id: "court-a" });
    noFalseCertainty();
  });

  it("(B1) no answer and no match found yet: uncertain ('couldn't confirm'), never 'not saved'; the sheet stays to try again after checking", async () => {
    view();
    db.rpc = [lost];
    db.found = false;
    await addWalkIn("Walk-in Ali");
    expect(await screen.findByText(DESK_UNCONFIRMED)).toBeTruthy();
    expect(sheetOpen()).toBe(true);
    noFalseCertainty();
    // the retry is refused because the first one did commit late: the calendar's booking is shown, not "taken"
    db.rpc = [{ data: null, error: { message: "slot_taken" } }];
    db.found = true;
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(sheetOpen()).toBe(false));
    expect(notice()).toContain("the calendar now shows a booking for Walk-in Ali");
    expect(screen.queryByText(/taken/)).toBeNull();
  });

  it("(B2) no answer and the calendar can't be read either: 'may have been saved … when the connection returns'", async () => {
    view();
    db.rpc = [lost];
    db.found = "fail";
    await addWalkIn("Walk-in Ali");
    expect(await screen.findByText(DESK_UNREACHABLE)).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    noFalseCertainty();
  });

  it("(b) Confirm cancellation whose answer is lost, booking now cancelled: the sheet closes, cancel is not offered again, no success claim", async () => {
    const b = walkIn("Rana Khoury");
    view([b]);
    await act(async () => { screen.getAllByRole("button", { name: /Rana Khoury/ })[0].click(); });
    await act(async () => { screen.getByRole("button", { name: "Cancel booking" }).click(); });
    db.rpc = [lost];
    db.found = true;
    db.day = [];
    await act(async () => { screen.getByRole("button", { name: "Confirm cancellation" }).click(); });
    await waitFor(() => expect(sheetOpen()).toBe(false));
    expect(notice()).toContain("the calendar now shows this booking as cancelled");
    expect(screen.queryByText(/no longer active|went wrong/)).toBeNull();
    noFalseCertainty();
    expect(db.checks.at(-1)).toMatchObject({ table: "bookings", id: b.id, status: "cancelled" });
  });

  it("(b2) a retried cancel refused 'no longer active' (cancelled by then, by this desk or another): the state is shown", async () => {
    view([walkIn("Rana Khoury")]);
    await act(async () => { screen.getAllByRole("button", { name: /Rana Khoury/ })[0].click(); });
    await act(async () => { screen.getByRole("button", { name: "Cancel booking" }).click(); });
    db.rpc = [{ data: null, error: { message: "not_confirmed" } }];
    db.found = true;
    await act(async () => { screen.getByRole("button", { name: "Confirm cancellation" }).click(); });
    await waitFor(() => expect(sheetOpen()).toBe(false));
    expect(notice()).toContain("this booking as cancelled");
    expect(screen.queryByText(/no longer active/)).toBeNull();
  });

  it("(c) a genuine slot_taken by someone else (no match): the grid is read again and shows them; the refusal stays", async () => {
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
    expect(notice()).toBeNull();
  });

  it("a new action clears the previous notice", async () => {
    view();
    db.rpc = [lost];
    db.found = true;
    await addWalkIn("Walk-in Ali");
    await waitFor(() => expect(notice()).not.toBeNull());
    db.rpc = [{ data: null, error: null }];
    db.found = null;
    await act(async () => { screen.getAllByRole("button", { name: /^Add booking Padel 1 1[1-9]:00/ })[0].click(); });
    fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Next" } });
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(notice()).toBeNull());
  });
});
