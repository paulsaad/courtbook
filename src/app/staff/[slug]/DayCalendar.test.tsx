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
/** Each test programmes what the next read of a table answers, and when. */
let handler: (table: string) => Promise<Resp>;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "not", "lt", "gt", "order", "insert", "delete"]) {
      chain[m] = () => chain;
    }
    const make = (table: string) => {
      chain.then = (res: (v: Resp) => unknown, rej?: (e: unknown) => unknown) => handler(table).then(res, rej);
      return chain;
    };
    return {
      from: (table: string) => make(table),
      rpc: async () => ({ data: [], error: null }),
      auth: { getUser: async () => ({ data: { user: { id: "staff-1" } } }) },
    };
  },
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
afterEach(cleanup);

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
    handler = async () => failed;
    const { rerender } = view({ view: "week", court: courtA.id });
    await waitFor(() => expect(screen.getByText(/Couldn't load the latest week/)).toBeDefined());

    // the day succeeds while the week on screen has failed
    handler = async () => ok([]);
    rerender(
      <DayCalendar club={club} courts={[courtA, courtB]} bookings={[]} blocks={[] as Block[]}
        date="2026-11-12" view="grid" sport={null} court={null} sportNames={{ padel: "Padel" }} />,
    );
    await waitFor(() => expect(screen.queryByText(/Couldn't load the latest/)).toBeNull());

    // back to the week: its own failure is still standing
    rerender(
      <DayCalendar club={club} courts={[courtA, courtB]} bookings={[]} blocks={[] as Block[]}
        date="2026-11-12" view="week" sport={null} court={courtA.id} sportNames={{ padel: "Padel" }} />,
    );
    expect(screen.getByText(/Couldn't load the latest week/)).toBeDefined();
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
