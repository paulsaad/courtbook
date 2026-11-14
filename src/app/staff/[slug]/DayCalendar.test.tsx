// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

// next/link needs a router in tests and all we want is an anchor
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

type Resp = { data: unknown[] | null; error: unknown };
/** What a query looked like by the time it was awaited. `court_id` is set only by the week read,
 *  which is how a test tells the day's request apart from the week's. */
type Query = { table: string; filters: Record<string, unknown> };
/** Each test programmes what a given query answers, and when. */
let handler: (q: Query) => Promise<Resp>;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    // a fresh builder per from(), or two queries running together would share one `then`
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const m of ["select", "or", "not", "lt", "gt", "order", "insert", "delete"]) b[m] = () => b;
      b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
      b.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) =>
        handler({ table, filters }).then(res, rej);
      return b;
    },
    rpc: async () => ({ data: [], error: null }),
    auth: { getUser: async () => ({ data: { user: { id: "staff-1" } } }) },
  }),
}));

import DayCalendar from "./DayCalendar";
import type { Block, Booking, Club, Court } from "@/lib/types";

const club: Club = {
  id: "club-1", name: "Batroun", slug: "batroun", timezone: "Asia/Beirut",
  slot_minutes: 30, cancel_cutoff_hours: 6, open_time: "08:00", close_time: "23:00",
  min_booking_minutes: 60, max_booking_minutes: 180,
};
const courtA: Court = { id: "court-a", name: "Padel 1", sport: "padel", surface: null, sort: 1, active: true };
const courtB: Court = { id: "court-b", name: "Padel 2", sport: "padel", surface: null, sort: 2, active: true };

const booking = (id: string, name: string): Booking => ({
  id, court_id: courtA.id, player_id: null, guest_name: name, guest_phone: null,
  start_at: "2026-11-12T07:00:00.000Z", end_at: "2026-11-12T08:00:00.000Z",
  status: "confirmed", source: "staff", credit_tx_id: null, price_usd: 20, fee_usd: 0,
});

/** A promise the test resolves when it chooses, so two reads can be left in flight at once. */
function deferred<T>() {
  let settle!: (v: T) => void;
  const promise = new Promise<T>((r) => { settle = r; });
  return { promise, settle };
}

const ok = (rows: unknown[]): Resp => ({ data: rows, error: null });
const failed: Resp = { data: null, error: { message: "network" } };

const view = (props: Partial<React.ComponentProps<typeof DayCalendar>> = {}) =>
  render(
    <DayCalendar
      club={club} courts={[courtA, courtB]} bookings={[]} blocks={[] as Block[]}
      date="2026-11-12" view="grid" sport={null} court={null} sportNames={{ padel: "Padel" }}
      {...props}
    />,
  );

const addButtons = () => screen.getAllByRole("button", { name: /^Add booking/ });
const retry = () => screen.getByRole("button", { name: /Retry|Checking/ });

beforeEach(() => { handler = async () => ok([]); });
const isWeekRead = (q: Query) => q.filters.court_id !== undefined;
afterEach(() => { cleanup(); vi.useRealTimers(); });   // a failing timer test must not leak into the next one

describe("staff calendar read state", () => {
  it("keeps adding disabled from a failed load until Retry actually succeeds", async () => {
    const first = deferred<Resp>();
    handler = () => first.promise;
    view({ loadFailed: true });

    // arrives failed: the banner is up and no slot can be booked
    expect(screen.getByText(/Couldn't load the latest/)).toBeDefined();
    expect(addButtons().every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    await act(async () => { retry().click(); });
    // still in flight: adding must stay off rather than opening up optimistically
    expect(addButtons().every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    await act(async () => { first.settle(failed); await Promise.resolve(); });
    // failed again: still off, banner still up
    expect(screen.getByText(/Couldn't load the latest/)).toBeDefined();
    expect(addButtons().every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    const second = deferred<Resp>();
    handler = () => second.promise;
    await act(async () => { retry().click(); });
    await act(async () => { second.settle(ok([booking("b1", "Walk In")])); await Promise.resolve(); });

    await waitFor(() => expect(screen.queryByText(/Couldn't load the latest/)).toBeNull());
    expect(addButtons().some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("does not let a successful day read clear a failed week read", async () => {
    // the week fails, the day succeeds — and Retry from the week view starts both
    handler = async (q) => (isWeekRead(q) ? failed : ok([]));
    const { rerender } = view({ view: "week", court: courtA.id });
    await waitFor(() => expect(screen.getByText(/Couldn't load the latest week/)).toBeDefined());

    await act(async () => { retry().click(); });
    await act(async () => { await Promise.resolve(); });

    // the day request succeeded, but the week on screen did not: the banner stays and so does the guard
    expect(screen.getByText(/Couldn't load the latest week/)).toBeDefined();
    const weekCells = screen.getAllByRole("button", { name: /^Add a booking on/ });
    expect(weekCells.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    // and the day really did come back clean: its own view shows no banner
    rerender(
      <DayCalendar club={club} courts={[courtA, courtB]} bookings={[]} blocks={[] as Block[]}
        date="2026-11-12" view="grid" sport={null} court={null} sportNames={{ padel: "Padel" }} />,
    );
    expect(screen.queryByText(/Couldn't load the latest/)).toBeNull();
    expect(addButtons().some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("ignores a day response that arrives after a newer one", async () => {
    // the real case: the Now view reloads on its own timer, so two reads can be in flight at once
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T07:30:00.000Z"));   // mid-way through the fixture booking
    const slow = deferred<Resp>();
    const fast = deferred<Resp>();
    let call = 0;
    handler = () => (++call <= 2 ? slow.promise : fast.promise);   // two tables make up one read
    view({ view: "now" });

    await act(async () => { await Promise.resolve(); });          // read 1 starts, and stays in flight
    await act(async () => { vi.advanceTimersByTime(60_000); });   // the timer fires read 2

    await act(async () => { fast.settle(ok([booking("new", "Newer")])); await Promise.resolve(); });
    expect(screen.getAllByText("Newer").length).toBeGreaterThan(0);

    // read 1 lands late with different rows: it must change nothing
    await act(async () => { slow.settle(ok([booking("old", "Older")])); await Promise.resolve(); });
    expect(screen.queryByText("Older")).toBeNull();
    expect(screen.getAllByText("Newer").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Couldn't load the latest/)).toBeNull();
    vi.useRealTimers();
  });

  it("never shows the previous court's week when the court is switched mid-request", async () => {
    const slow = deferred<Resp>();
    let call = 0;
    // the week grid prints a first name only, so the two courts' bookings are told apart by that
    handler = () => (++call <= 2 ? slow.promise : Promise.resolve(ok([{ ...booking("b", "Bee"), court_id: courtB.id }])));
    const { rerender } = view({ view: "week", court: courtA.id });

    rerender(
      <DayCalendar club={club} courts={[courtA, courtB]} bookings={[]} blocks={[] as Block[]}
        date="2026-11-12" view="week" sport={null} court={courtB.id} sportNames={{ padel: "Padel" }} />,
    );
    await waitFor(() => expect(screen.getAllByText("Bee").length).toBeGreaterThan(0));

    // court A's answer arrives after the switch
    await act(async () => { slow.settle(ok([{ ...booking("a", "Ayy"), court_id: courtA.id }])); await Promise.resolve(); });
    expect(screen.queryByText("Ayy")).toBeNull();
    expect(screen.getAllByText("Bee").length).toBeGreaterThan(0);
  });
});

describe("staff calendar lengths follow the club's limits (Phase 9 / 0066)", () => {
  const radios = (group: string) => screen.getByRole("radiogroup", { name: group }).querySelectorAll("[role=radio]");
  const labels = (group: string) => Array.from(radios(group)).map((r) => r.textContent);

  it("a walk-in offers 1 h to 3 h, a block offers its own lengths", async () => {
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    expect(labels("Booking length")).toEqual(["1 h", "1 h 30", "2 h", "2 h 30", "3 h"]);
    expect(screen.getByRole("button", { name: "Add booking" })).toBeDefined();
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    expect(labels("Block length")).toEqual(["30 min", "1 h", "1 h 30", "2 h", "2 h 30", "3 h", "3 h 30", "4 h"]);
    expect(screen.getByRole("button", { name: "Block this time" })).toBeDefined();
  });

  it("near closing: no booking length fits, but a 30 min block does", async () => {
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 22:30" }).click(); });
    expect(screen.getByText(/Not enough time before closing for a booking/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Add booking" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    expect(labels("Block length")).toEqual(["30 min"]);
    expect((screen.getByRole("button", { name: "Block this time" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("moving an older 30 min booking keeps its length available, alongside 1 h to 3 h", async () => {
    const short: Booking = { ...booking("b30", "Short Walk In"), end_at: "2026-11-12T07:30:00.000Z" };   // 09:00–09:30
    view({ bookings: [short] });
    await act(async () => { screen.getAllByRole("button", { name: /Short Walk In/ })[0].click(); });
    await act(async () => { screen.getByRole("button", { name: "Move" }).click(); });
    const select = screen.getByDisplayValue("30 min (current)") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["30 min (current)", "1 h", "1 h 30", "2 h", "2 h 30", "3 h"]);
  });
});
