// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, replace: nav.replace }) }));

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
/** Each test may programme the RPCs too (staff_book, club_recent_guests …); by default they answer nothing. */
let rpcImpl: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }> = async () => ({ data: [], error: null });

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
    rpc: (fn: string, args: unknown) => rpcImpl(fn, args),
    auth: { getUser: async () => ({ data: { user: { id: "staff-1" } } }) },
  }),
}));

import DayCalendar, { AddSheet } from "./DayCalendar";
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
    view({ date: "2099-01-12" });                                  // a future day: no slot has ended
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    expect(labels("Booking length")).toEqual(["1 h", "1 h 30", "2 h", "2 h 30", "3 h"]);
    expect(screen.getByRole("button", { name: "Add booking" })).toBeDefined();
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    // a block: start and end selectors, any end on the grid up to closing (no 4 h limit any more)
    const end = screen.getByLabelText("Block end") as HTMLSelectElement;
    const ends = Array.from(end.options).map((o) => o.textContent);
    expect(ends[0]).toBe("10:30");
    expect(ends[ends.length - 1]).toBe("23:00");
    expect((screen.getByLabelText("Block start") as HTMLSelectElement).value).toBe(String(10 * 60));
    expect(screen.getByRole("button", { name: "Block this time" })).toBeDefined();
  });

  it("near closing: no booking length fits, but a 30 min block does", async () => {
    view({ date: "2099-01-12" });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 22:30" }).click(); });
    expect(screen.getByText(/Not enough time before closing for a booking/)).toBeDefined();
    expect((screen.getByRole("button", { name: "Add booking" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    expect(Array.from((screen.getByLabelText("Block end") as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(["23:00"]);
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

describe("walk-in sheet: a block never takes the customer's name (review fix)", () => {
  const sheet = (time: string, onSave = vi.fn(), c: Club = club) => {
    render(<AddSheet club={c} court={courtA} time={time} busy={false} defaultMinutes={60} onSave={onSave} />);
    return onSave;
  };

  it("switching to a block after typing a name blocks with no reason, and the name is kept for the booking", async () => {
    const onSave = sheet("10:00");
    fireEvent.change(screen.getByLabelText("Customer name"), { target: { value: "Ali Haddad" } });
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    expect((screen.getByLabelText("Block reason") as HTMLInputElement).value).toBe("");
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
    expect(onSave).toHaveBeenCalledWith("", "", 2, true, "10:00", "11:00");       // reason empty, not "Ali Haddad"
    await act(async () => { screen.getByRole("button", { name: "Back to booking" }).click(); });
    expect((screen.getByLabelText("Customer name") as HTMLInputElement).value).toBe("Ali Haddad");
  });

  it("a block reason never becomes the customer's name", async () => {
    const onSave = sheet("10:00");
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    fireEvent.change(screen.getByLabelText("Block reason"), { target: { value: "Net repair" } });
    await act(async () => { screen.getByRole("button", { name: "Back to booking" }).click(); });
    expect((screen.getByLabelText("Customer name") as HTMLInputElement).value).toBe("");
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
    expect(onSave).toHaveBeenCalledWith("Net repair", "", 2, true, "10:00", "11:00");
  });

  it("when no block length fits before closing, it says so for a block and cannot save", async () => {
    const onSave = sheet("22:45");                                // 15 min left on a 30 min grid
    expect(screen.getByText(/Not enough time before closing for a booking/)).toBeDefined();
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    expect(screen.getByText("Not enough time before closing for a block.")).toBeDefined();
    expect(screen.queryByText(/for a booking/)).toBeNull();
    expect((screen.getByRole("button", { name: "Block this time" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("calendar header links (Phase I-1)", () => {
  it("Payments and Settings are hidden from 1024 px, where the staff bar has them; shown on phones and tablets", () => {
    const src = readFileSync("src/app/staff/[slug]/DayCalendar.tsx", "utf8");
    expect(src).toMatch(/payments`\} className="text-muted lg:hidden">Payments</);
    expect(src).toMatch(/settings`\} className="text-muted lg:hidden">Settings</);
  });
});

/** A screen width the test can change while the page is open (the browser's "change" event). */
const screenWidth = { desktop: false, listeners: new Set<() => void>() };
const desktop = (on: boolean) => {
  screenWidth.desktop = on;
  window.matchMedia = ((q: string) => ({
    get matches() { return screenWidth.desktop && q.includes("1024"); }, media: q,
    addEventListener: (_: string, f: () => void) => { screenWidth.listeners.add(f); },
    removeEventListener: (_: string, f: () => void) => { screenWidth.listeners.delete(f); },
  })) as unknown as typeof window.matchMedia;
};
const resizeTo = (on: boolean) => { screenWidth.desktop = on; screenWidth.listeners.forEach((f) => f()); };
const typeName = (v: string) => fireEvent.change(screen.getByRole("combobox", { name: "Customer name" }), { target: { value: v } });

describe("Phase I-2a: phone keeps the modal bottom sheet", () => {
  beforeEach(() => { handler = async () => ok([]); desktop(false); });
  it("labelled modal dialog; tapping outside closes it, as before (no question even with typed details)", async () => {
    const { container } = view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    const dialog = screen.getByRole("dialog", { name: "Add a booking" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector("aside")).toBeNull();
    typeName("Rami");
    const confirm = vi.spyOn(window, "confirm");
    await act(async () => { fireEvent.click(dialog.parentElement!); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("Phase I-2a: desktop side panel beside the calendar", () => {
  beforeEach(() => { handler = async () => ok([]); desktop(true); nav.push.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); desktop(false); });

  it("is a non-modal panel with title and Close; the calendar stays usable while it is open", async () => {
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    const panel = screen.getByRole("dialog", { name: "Add a booking" });
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.parentElement!.className).toContain("w-[400px]");          // the side column, not an overlay
    expect(panel.parentElement!.className).not.toContain("fixed");
    expect(screen.getByRole("heading", { name: "Add a booking" })).toBeDefined();
    // another slot can be clicked straight away (nothing typed yet)
    expect((screen.getByRole("button", { name: "Add booking Padel 2 11:00" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 2 11:00" }).click(); });
    expect(screen.getByRole("heading", { name: /Padel 2, 11:00/ })).toBeDefined();
    await act(async () => { screen.getByRole("button", { name: "Close" }).click(); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switching slots with typed details asks first; Cancel keeps them, OK opens the new slot empty", async () => {
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    typeName("Rami");
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 2 11:00" }).click(); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("combobox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
    expect(screen.getByRole("heading", { name: /Padel 1, 10:00/ })).toBeDefined();
    confirm.mockReturnValueOnce(true);
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 2 11:00" }).click(); });
    expect(screen.getByRole("heading", { name: /Padel 2, 11:00/ })).toBeDefined();
    expect((screen.getByRole("combobox", { name: "Customer name" }) as HTMLInputElement).value).toBe("");
  });

  it("Close and Esc with typed details ask first too", async () => {
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    typeName("Rami");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => { screen.getByRole("button", { name: "Close" }).click(); });
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("Enter in a text field never creates a booking; only the button does", async () => {
    const calls: string[] = [];
    rpcImpl = async (fn) => { calls.push(fn); return { data: [], error: null }; };
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    typeName("Rami");
    const nameField = screen.getByRole("combobox", { name: "Customer name" });
    // a browser submits a form when Enter is pressed in a field unless the keydown is cancelled: it is
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { nameField.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(true);
    const phoneField = screen.getByPlaceholderText("Phone (optional)");
    const ev2 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { phoneField.dispatchEvent(ev2); });
    expect(ev2.defaultPrevented).toBe(true);
    expect(calls).not.toContain("staff_book");
    // the button still saves
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(calls).toContain("staff_book"));
    rpcImpl = async () => ({ data: [], error: null });
  });

  it("a conflict keeps the typed details, shows the error, and is not retried", async () => {
    const calls: string[] = [];
    rpcImpl = async (fn) => { if (fn === "staff_book") { calls.push(fn); return { data: null, error: { message: "slot_taken" } }; } return { data: [], error: null }; };
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    typeName("Rami");
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(calls).toEqual(["staff_book"]);
    expect((screen.getByRole("combobox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
    expect(screen.getByRole("dialog", { name: "Add a booking" })).toBeDefined();
    rpcImpl = async () => ({ data: [], error: null });
  });

  it("automatic refresh keeps the open panel and its typed details; a failed refresh marks the day as possibly outdated", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      view();
      await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
      typeName("Rami");
      handler = async () => failed;
      await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
      expect(screen.getByText(/Couldn.t load the latest bookings/)).toBeDefined();
      expect((screen.getByRole("combobox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
      expect(screen.getByRole("dialog", { name: "Add a booking" })).toBeDefined();
      expect(nav.push).not.toHaveBeenCalled();                 // the date never changes by itself
      // fail-safe kept: no new add form can be opened while the day may be out of date
      expect((screen.getByRole("button", { name: "Add booking Padel 2 11:00" }) as HTMLButtonElement).disabled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("keyboard: ← / → / T change the day; ignored while typing, inside the panel, or with a modifier", async () => {
    view();
    await act(async () => { fireEvent.keyDown(document.body, { key: "ArrowRight" }); });
    expect(nav.push).toHaveBeenLastCalledWith(expect.stringContaining("date=2026-11-13"));
    await act(async () => { fireEvent.keyDown(document.body, { key: "ArrowLeft" }); });
    expect(nav.push).toHaveBeenLastCalledWith(expect.stringContaining("date=2026-11-11"));
    nav.push.mockReset();
    await act(async () => { fireEvent.keyDown(document.body, { key: "ArrowRight", ctrlKey: true }); });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    const field = screen.getByRole("combobox", { name: "Customer name" });
    await act(async () => { fireEvent.keyDown(field, { key: "ArrowRight" }); fireEvent.keyDown(field, { key: "t" }); });
    await act(async () => { fireEvent.keyDown(screen.getByRole("heading", { name: "Add a booking" }), { key: "ArrowLeft" }); });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("keyboard: changing day with typed details asks first", async () => {
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    typeName("Rami");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => { fireEvent.keyDown(document.body, { key: "ArrowRight" }); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe("Phase I-2a review: crossing 1024 px and focused controls", () => {
  beforeEach(() => { handler = async () => ok([]); nav.push.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); desktop(false); });

  it.each([[false, true], [true, false]])("typed details survive resizing (start desktop=%s → %s) and back", async (start, end) => {
    desktop(start);
    view();
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    typeName("Rami");
    fireEvent.change(screen.getByPlaceholderText("Phone (optional)"), { target: { value: "03 123 456" } });
    await act(async () => { resizeTo(end); });
    const dialog = screen.getByRole("dialog", { name: "Add a booking" });
    expect(dialog.getAttribute("aria-modal")).toBe(end ? "false" : "true");
    expect((screen.getByRole("combobox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
    expect((screen.getByPlaceholderText("Phone (optional)") as HTMLInputElement).value).toBe("03 123 456");
    await act(async () => { resizeTo(start); });
    expect((screen.getByRole("combobox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
    expect(screen.getByRole("dialog", { name: "Add a booking" }).getAttribute("aria-modal")).toBe(start ? "false" : "true");
  });

  it("← / → do nothing while a slot, a link or another control has keyboard focus", async () => {
    desktop(true);
    view();
    const slot = screen.getByRole("button", { name: "Add booking Padel 1 10:00" });
    slot.focus();
    await act(async () => { fireEvent.keyDown(slot, { key: "ArrowRight" }); fireEvent.keyDown(slot, { key: "t" }); });
    const link = screen.getByRole("link", { name: "Next day" });
    link.focus();
    await act(async () => { fireEvent.keyDown(link, { key: "ArrowLeft" }); });
    expect(nav.push).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    await act(async () => { fireEvent.keyDown(document.body, { key: "ArrowRight" }); });
    expect(nav.push).toHaveBeenCalledTimes(1);
  });
});


describe("Calendar blocks (0076): longer blocks, start/end selectors and the 'Not saved' highlight", () => {
  const DAY = "2099-01-12";                                          // a future day (Beirut UTC+2 in January)
  const z = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+02:00`).toISOString();
  const open = async (label = "Add booking Padel 1 10:00") => { await act(async () => { screen.getByRole("button", { name: label }).click(); }); };
  const toBlock = async () => { await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); }); };
  const pick = (label: string, hhmm: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: String(Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) } });
  const draft = () => screen.queryByTestId("draft");
  const column = (el: HTMLElement) => el.parentElement!;
  let calls: { fn: string; args: Record<string, unknown> }[];
  beforeEach(() => {
    handler = async () => ok([]); desktop(true); calls = [];
    rpcImpl = async (fn, args) => { calls.push({ fn, args: args as Record<string, unknown> }); return { data: fn === "staff_block" ? "blk-1" : [], error: null }; };
  });
  afterEach(() => { vi.restoreAllMocks(); desktop(false); rpcImpl = async () => ({ data: [], error: null }); });

  it("a 10-hour block is saved once, through staff_block, with the exact start and end", async () => {
    view({ date: DAY });
    await open(); await toBlock();
    pick("Block end", "20:00");
    fireEvent.change(screen.getByLabelText("Block reason"), { target: { value: "Tournament" } });
    expect(screen.getByRole("heading", { name: "Padel 1, 10:00–20:00 · block" })).toBeDefined();
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
    await waitFor(() => expect(calls.filter((c) => c.fn === "staff_block")).toHaveLength(1));
    expect(calls.find((c) => c.fn === "staff_block")!.args).toEqual({
      p_club: "club-1", p_court: "court-a", p_start: z("10:00"), p_end: z("20:00"), p_reason: "Tournament",
    });
  });

  it("the start can be moved earlier or later; the save uses it", async () => {
    view({ date: DAY });
    await open(); await toBlock();
    pick("Block start", "09:00");
    pick("Block end", "12:00");
    expect(screen.getByRole("heading", { name: "Padel 1, 09:00–12:00 · block" })).toBeDefined();
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
    await waitFor(() => expect(calls.find((c) => c.fn === "staff_block")?.args).toMatchObject({ p_start: z("09:00"), p_end: z("12:00"), p_reason: null }));
  });

  it("the end stops at the next booking on that court; another court is not limited by it", async () => {
    const later: Booking = { ...booking("b-later", "Later Game"), start_at: z("12:00"), end_at: z("13:00") };
    view({ date: DAY, bookings: [later] });
    await open(); await toBlock();
    const ends = () => Array.from((screen.getByLabelText("Block end") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(ends()).toEqual(["10:30", "11:00", "11:30", "12:00"]);
    await act(async () => { screen.getByRole("button", { name: "Close" }).click(); });
    await open("Add booking Padel 2 10:00"); await toBlock();
    expect(ends()[ends().length - 1]).toBe("23:00");
  });

  it("highlights the selected court and the whole interval at once, and follows every change", async () => {
    view({ date: DAY });
    expect(draft()).toBeNull();
    await open();
    expect(draft()!.textContent).toBe("Not saved10:00–11:00");                      // a booking, default length
    expect(column(draft()!).querySelector('[aria-label="Add booking Padel 1 10:00"]')).not.toBeNull();
    expect(column(draft()!).querySelector('[aria-label="Add booking Padel 2 10:00"]')).toBeNull();
    await act(async () => { screen.getByRole("radio", { name: "2 h" }).click(); });
    expect(draft()!.textContent).toBe("Not saved10:00–12:00");
    await toBlock();
    pick("Block end", "16:00");
    expect(draft()!.textContent).toBe("Not saved10:00–16:00 · block");
    pick("Block start", "08:00");
    expect(draft()!.textContent).toBe("Not saved08:00–16:00 · block");
    expect(draft()!.className).toContain("border-dashed");
    expect(draft()!.className).toContain("pointer-events-none");                    // the slots under it stay tappable
    expect(draft()!.getAttribute("aria-hidden")).toBe("true");                       // the panel heading says it in words
  });

  it("disappears when the panel closes and moves with a new selection", async () => {
    view({ date: DAY });
    await open();
    await act(async () => { screen.getByRole("button", { name: "Close" }).click(); });
    expect(draft()).toBeNull();
    await open();
    await open("Add booking Padel 2 11:00");                                        // nothing chosen or typed: no question
    expect(column(draft()!).querySelector('[aria-label="Add booking Padel 2 11:00"]')).not.toBeNull();
    expect(screen.getAllByTestId("draft")).toHaveLength(1);
  });

  it("is never shown as a saved block: the hatched block appears only from the database's answer", async () => {
    const answer = deferred<{ data: unknown; error: { message: string } | null }>();
    rpcImpl = async (fn) => (fn === "staff_block" ? answer.promise : { data: [], error: null });
    view({ date: DAY });
    await open(); await toBlock();
    pick("Block end", "14:00");
    fireEvent.change(screen.getByLabelText("Block reason"), { target: { value: "Net repair" } });
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
    expect(draft()).not.toBeNull();                                                  // saving: still "Not saved"
    expect(screen.queryByRole("button", { name: /^Net repair,/ })).toBeNull();
    const saved: Block = { id: "blk-1", court_id: courtA.id, start_at: z("10:00"), end_at: z("14:00"), reason: "Net repair" };
    handler = async (q) => ok(q.table === "blocks" ? [saved] : []);
    await act(async () => { answer.settle({ data: "blk-1", error: null }); });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Net repair,/ })).toBeDefined());
    expect(draft()).toBeNull();
  });

  it("a conflict keeps the selection, the highlight and the reason, says why, and is not retried", async () => {
    rpcImpl = async (fn, args) => {
      calls.push({ fn, args: args as Record<string, unknown> });
      return fn === "staff_block" ? { data: null, error: { message: 'conflicting key value violates exclusion constraint "no_overlapping_blocks"' } } : { data: [], error: null };
    };
    view({ date: DAY });
    await open(); await toBlock();
    pick("Block end", "18:00");
    fireEvent.change(screen.getByLabelText("Block reason"), { target: { value: "Event" } });
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("That range is already blocked."));
    expect(calls.filter((c) => c.fn === "staff_block")).toHaveLength(1);
    expect((screen.getByLabelText("Block end") as HTMLSelectElement).value).toBe(String(18 * 60));
    expect((screen.getByLabelText("Block reason") as HTMLInputElement).value).toBe("Event");
    expect(draft()!.textContent).toBe("Not saved10:00–18:00 · block");
  });

  it("a changed end or length counts as unsaved: switching slots asks first, and Cancel keeps it", async () => {
    view({ date: DAY });
    await open(); await toBlock();
    pick("Block end", "15:00");
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    await open("Add booking Padel 2 11:00");
    expect(confirm).toHaveBeenCalledWith("Discard the details you have entered?");
    expect((screen.getByLabelText("Block end") as HTMLSelectElement).value).toBe(String(15 * 60));
    expect(draft()!.textContent).toBe("Not saved10:00–15:00 · block");
    await act(async () => { screen.getByRole("button", { name: "Close" }).click(); });  // asks again; OK this time
    confirm.mockReturnValueOnce(true);
    await act(async () => { screen.getByRole("button", { name: "Close" }).click(); });
    await open();
    await act(async () => { screen.getByRole("radio", { name: "2 h" }).click(); });  // a booking length the desk chose
    confirm.mockReturnValueOnce(false);
    await open("Add booking Padel 2 11:00");
    expect(screen.getByRole("heading", { name: /Padel 1, 10:00–12:00/ })).toBeDefined();
  });

  it("week view: the chosen cells of that day are highlighted, and only those", async () => {
    view({ date: DAY, view: "week", court: courtA.id });
    const cell = await screen.findByRole("button", { name: "Add a booking on 2099-01-13 at 10:00" });
    await waitFor(() => expect((cell as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { cell.click(); });
    const marked = () => Array.from(document.querySelectorAll('[data-draft="true"]')).map((e) => e.getAttribute("aria-label"));
    expect(marked()).toEqual(["Add a booking on 2099-01-13 at 10:00", "Add a booking on 2099-01-13 at 10:30"]);
    await toBlock();
    pick("Block end", "12:00");
    expect(marked()).toHaveLength(4);
    expect(screen.getByText("Not saved")).toBeDefined();
  });

  it("today: a block cannot start in a slot that has already ended; the running slot is offered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2099-01-12T12:10:00.000Z"));          // 14:10 in Beirut
    try {
      view({ date: DAY });
      await open();                                                   // 10:00 is over
      await toBlock();
      const start = screen.getByLabelText("Block start") as HTMLSelectElement;
      expect(start.value).toBe(String(14 * 60));
      expect(Array.from(start.options)[0].textContent).toBe("14:00");
    } finally { vi.useRealTimers(); }
  });
});

describe("Calendar blocks: closing time, midnight and the clock-change nights (review 2)", () => {
  const night: Club = { ...club, open_time: "00:00", close_time: "24:00:00" };
  let calls: { fn: string; args: Record<string, unknown> }[];
  beforeEach(() => {
    handler = async () => ok([]); desktop(true); calls = [];
    rpcImpl = async (fn, args) => { calls.push({ fn, args: args as Record<string, unknown> }); return { data: fn === "staff_block" ? "blk-1" : [], error: null }; };
  });
  afterEach(() => { vi.restoreAllMocks(); desktop(false); rpcImpl = async () => ({ data: [], error: null }); });
  const blockFrom = async (c: Club, day: string, from: string, to: string) => {
    view({ club: c, date: day });
    await act(async () => { screen.getByRole("button", { name: `Add booking Padel 1 ${from}` }).click(); });
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    const ends = Array.from((screen.getByLabelText("Block end") as HTMLSelectElement).options).map((o) => o.textContent);
    fireEvent.change(screen.getByLabelText("Block end"), { target: { value: String(Number(to.slice(0, 2)) * 60 + Number(to.slice(3))) } });
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
    await waitFor(() => expect(calls.filter((x) => x.fn === "staff_block")).toHaveLength(1));
    return { ends, args: calls.find((x) => x.fn === "staff_block")!.args };
  };

  it("a block can end exactly at closing time (23:00)", async () => {
    const { ends, args } = await blockFrom(club, "2099-01-12", "22:00", "23:00");
    expect(ends[ends.length - 1]).toBe("23:00");
    expect(args).toMatchObject({ p_start: "2099-01-12T20:00:00.000Z", p_end: "2099-01-12T21:00:00.000Z" });
  });
  it("a club closing at midnight: the block can end at 24:00, sent as the next day's 00:00", async () => {
    const { ends, args } = await blockFrom(night, "2099-01-12", "22:00", "24:00");
    expect(ends[ends.length - 1]).toBe("24:00");
    expect(args).toMatchObject({ p_start: "2099-01-12T20:00:00.000Z", p_end: "2099-01-12T22:00:00.000Z" });
  });
  it("the night the clocks go back (30 Oct 2027): 22:00–24:00 is sent as the 3 real hours chosen", async () => {
    const { args } = await blockFrom(night, "2027-10-30", "22:00", "24:00");
    expect(args).toMatchObject({ p_start: "2027-10-30T19:00:00.000Z", p_end: "2027-10-30T22:00:00.000Z" });
  });
  it("the night the clocks go forward (27 Mar 2027): midnight is sent as the real start of the next day", async () => {
    const { args } = await blockFrom(night, "2027-03-27", "22:00", "24:00");
    expect(args).toMatchObject({ p_start: "2027-03-27T20:00:00.000Z", p_end: "2027-03-27T22:00:00.000Z" });   // not 21:00Z, an hour early
  });
});

describe("Calendar blocks: after saving, and refusals in words about blocks (review 2)", () => {
  const DAY = "2099-01-12";
  let calls: string[];
  beforeEach(() => { handler = async () => ok([]); desktop(true); calls = []; });
  afterEach(() => { vi.restoreAllMocks(); desktop(false); rpcImpl = async () => ({ data: [], error: null }); });
  const block = async () => {
    view({ date: DAY });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    await act(async () => { screen.getByRole("button", { name: "Block this time" }).click(); });
  };

  it("saved but the refresh fails: says it was saved and may be out of date, adding stays off, never saved again", async () => {
    rpcImpl = async (fn) => { calls.push(fn); if (fn === "staff_block") handler = async () => failed; return { data: fn === "staff_block" ? "blk-1" : [], error: null }; };
    await block();
    await waitFor(() => expect(screen.getByText(/Saved\. Couldn.t load the latest bookings/)).toBeDefined());
    expect(screen.queryByRole("dialog", { name: "Add a booking" })).toBeNull();     // the save is done: the panel closed
    expect((screen.getByRole("button", { name: "Add booking Padel 2 11:00" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { screen.getByRole("button", { name: /Retry|Checking/ }).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(calls.filter((f) => f === "staff_block")).toHaveLength(1);
    handler = async () => ok([]);                                                  // a read works again: back to normal
    await act(async () => { screen.getByRole("button", { name: /Retry|Checking/ }).click(); });
    await waitFor(() => expect(screen.queryByText(/Couldn.t load/)).toBeNull());
    expect(screen.queryByText(/Saved\./)).toBeNull();
  });

  it.each([
    ["not_on_grid", "A block must start and end on the club's 30-minute time grid."],
    ["bad_duration", "A block must start and end on the club's 30-minute time grid."],
    ["outside_opening_hours", "A block must be within opening hours (08:00–23:00), on one day."],
    ["slot_in_past", "That time has already passed. A block must end later than now."],
    ["block_overlaps_booking", "There is a booking in that range. Cancel or move it first."],
    ["overlaps_existing_block", "That range is already blocked."],
  ])("a refused block (%s) is explained without booking-length rules", async (code, text) => {
    rpcImpl = async (fn) => (fn === "staff_block" ? { data: null, error: { message: code } } : { data: [], error: null });
    await block();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(text));
    expect(screen.getByRole("alert").textContent).not.toMatch(/what the club allows|Bookings here/);
  });

  it("a refused booking keeps the booking wording", async () => {
    rpcImpl = async (fn) => (fn === "staff_book" ? { data: null, error: { message: "bad_duration" } } : { data: [], error: null });
    view({ date: DAY });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    fireEvent.change(screen.getByRole("combobox", { name: "Customer name" }), { target: { value: "Rami" } });
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Duration must be whole slots, within what the club allows."));
  });
});

describe("UI corrections from the staging review (21 Nov)", () => {
  it("block Start/End are styled as usable dropdowns; while saving they are disabled (grey)", () => {
    const { rerender } = render(<AddSheet club={club} court={courtA} time="10:00" busy={false} defaultMinutes={60} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Block this time instead" }));
    for (const label of ["Block start", "Block end"]) {
      const el = screen.getByLabelText(label) as HTMLSelectElement;
      expect(el.className).toContain("select-field");
      expect(el.className).not.toContain("bg-paper");                    // the grey that looked disabled
      expect(el.disabled).toBe(false);
    }
    rerender(<AddSheet club={club} court={courtA} time="10:00" busy={true} defaultMinutes={60} onSave={vi.fn()} />);
    expect((screen.getByLabelText("Block start") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Block end") as HTMLSelectElement).disabled).toBe(true);
  });

  it("the dropdown style: white, clear border, chevron, focus ring; disabled is visibly different", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.:()]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    const base = rule(".select-field");
    expect(base).toMatch(/background-color:\s*#ffffff/);
    expect(base).toMatch(/border:\s*1px solid #8a918e/);
    expect(base).toMatch(/background-image:\s*url\("data:image\/svg\+xml/);
    expect(rule(".select-field:focus-visible")).toMatch(/outline:\s*2px solid/);
    const off = rule(".select-field:disabled");
    expect(off).toMatch(/background-color:\s*var\(--color-paper\)/);
    expect(off).toMatch(/color:\s*var\(--color-muted\)/);
    expect(off).toMatch(/cursor:\s*not-allowed/);
  });

  it("Home: the greeting's notification bell is for phones and tablets only (the desktop top bar has one)", () => {
    const src = readFileSync("src/app/page.tsx", "utf8");
    expect(src).toMatch(/<Link href="\/notifications" aria-label="Activity" className="[^"]*\blg:hidden\b[^"]*">/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Phase I-2b: keyboard grid, focus return, customer suggestions, find a booking, preferences, details
// ---------------------------------------------------------------------------------------------------------
describe("Phase I-2b: keyboard calendar", () => {
  const DAY = "2099-01-12";                                            // future, Beirut UTC+2
  const z = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+02:00`).toISOString();
  const rami: Booking = { ...booking("b-rami", "Rami Haddad"), start_at: z("11:00"), end_at: z("12:30"), guest_phone: "+961 3 123 456" };
  const net: Block = { id: "k-net", court_id: courtB.id, start_at: z("10:00"), end_at: z("12:00"), reason: "Net repair" };
  const group = () => screen.getByRole("group", { name: /^Courts,/ });
  const focused = () => document.activeElement as HTMLElement;
  const key = async (k: string, el: Element = focused(), extra = {}) => { await act(async () => { fireEvent.keyDown(el, { key: k, ...extra }); }); };
  beforeEach(() => { handler = async () => ok([]); desktop(true); nav.push.mockReset(); nav.replace.mockReset(); window.localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); desktop(false); rpcImpl = async () => ({ data: [], error: null }); });

  it("the grid is one Tab stop; arrows move between times and courts", async () => {
    view({ date: DAY, bookings: [rami], blocks: [net] });
    const tabbable = Array.from(group().querySelectorAll<HTMLElement>("button")).filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("aria-label")).toBe("Add booking Padel 1 08:00");
    await act(async () => { tabbable[0].focus(); });
    await key("ArrowDown");
    expect(focused().getAttribute("aria-label")).toBe("Add booking Padel 1 08:30");
    await key("ArrowRight");
    expect(focused().getAttribute("aria-label")).toBe("Add booking Padel 2 08:30");
    await key("End");
    expect(focused().getAttribute("aria-label")).toBe("Add booking Padel 2 22:30");
    await key("Home");
    expect(focused().getAttribute("aria-label")).toBe("Add booking Padel 2 08:00");
    // the I-2a day keys do not fire from inside the grid
    await key("ArrowLeft"); await key("ArrowLeft");
    expect(nav.push).not.toHaveBeenCalled();
    expect(focused().getAttribute("aria-label")).toBe("Add booking Padel 1 08:00");
  });

  it("a booking or block is one stop: arrows land on it and step past it; covered slots are not reachable", async () => {
    view({ date: DAY, bookings: [rami], blocks: [net] });
    // the free slots under Rami (11:00–12:30) and the block (10:00–12:00) are not exposed at all
    expect(screen.queryByRole("button", { name: "Add booking Padel 1 11:00" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add booking Padel 2 10:30" })).toBeNull();
    const covered = group().querySelector<HTMLButtonElement>('[data-cell="court-a:6"]')!;   // Padel 1 11:00
    expect(covered.disabled).toBe(true);
    expect(covered.getAttribute("aria-hidden")).toBe("true");
    expect(covered.tabIndex).toBe(-1);
    // 10:30 → ↓ → Rami (11:00–12:30) → ↓ → 12:30
    await act(async () => { (group().querySelector('[data-cell="court-a:5"]') as HTMLElement).focus(); });
    await key("ArrowDown");
    expect(focused().getAttribute("aria-label")).toBe("Rami Haddad, Padel 1, 11:00–12:30, desk booking, +961 3 123 456");
    // → at 11:00 is the block on Padel 2, announced as what it is; ← back to Rami
    await key("ArrowRight");
    expect(focused().getAttribute("aria-label")).toBe("Net repair, Padel 2, 10:00–12:00, blocked");
    await key("ArrowLeft");
    expect(focused().getAttribute("aria-label")).toMatch(/^Rami Haddad,/);
    await key("ArrowDown");
    expect(focused().getAttribute("aria-label")).toBe("Add booking Padel 1 12:30");
    await key("ArrowUp");
    expect(focused().getAttribute("aria-label")).toMatch(/^Rami Haddad,/);
    // from Rami's last half hour (12:00) → is Padel 2 at 12:00, free again after the block
    await key("ArrowRight");
    expect(focused().getAttribute("aria-label")).toBe("Add booking Padel 2 12:00");
  });

  it("Esc closes the panel and puts focus back on the cell it was opened from", async () => {
    view({ date: DAY, bookings: [rami] });
    const slot = screen.getByRole("button", { name: "Add booking Padel 2 15:00" });
    await act(async () => { slot.focus(); slot.click(); });
    expect(screen.getByRole("dialog", { name: "Add a booking" })).toBeDefined();
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(focused()).toBe(screen.getByRole("button", { name: "Add booking Padel 2 15:00" }));
    // the same for a booking
    await act(async () => { screen.getByRole("button", { name: /^Rami Haddad,/ }).click(); });
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(focused().getAttribute("aria-label")).toMatch(/^Rami Haddad,/);
  });

  it("after a save, focus goes to the saved booking once the calendar has re-read it", async () => {
    const saved: Booking = { ...booking("b-new", "Maya Khoury"), court_id: courtB.id, start_at: z("15:00"), end_at: z("16:00") };
    rpcImpl = async (fn) => { if (fn === "staff_book") handler = async (q) => ok(q.table === "bookings" ? [saved] : []); return { data: [], error: null }; };
    view({ date: DAY });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 2 15:00" }).click(); });
    fireEvent.change(screen.getByRole("combobox", { name: "Customer name" }), { target: { value: "Maya Khoury" } });
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(focused().getAttribute("aria-label")).toMatch(/^Maya Khoury, Padel 2, 15:00–16:00/));
  });

  it("saved but the refresh failed: focus falls back safely to the calendar (the slot is not offered)", async () => {
    rpcImpl = async (fn) => { if (fn === "staff_book") handler = async () => failed; return { data: [], error: null }; };
    view({ date: DAY });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 2 15:00" }).click(); });
    fireEvent.change(screen.getByRole("combobox", { name: "Customer name" }), { target: { value: "Maya" } });
    await act(async () => { screen.getByRole("button", { name: "Add booking" }).click(); });
    await waitFor(() => expect(screen.getByText(/Saved\. Couldn.t load/)).toBeDefined());
    await waitFor(() => expect(focused()).toBe(group()));
    expect(group().tabIndex).toBe(0);                                 // still reachable by Tab while adding is off
  });

  it("arrow keys in fields, dropdowns and the search box never move around the grid or change the day", async () => {
    view({ date: DAY });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    const nameField = screen.getByRole("combobox", { name: "Customer name" });
    await key("ArrowDown", nameField); await key("ArrowLeft", nameField);
    await act(async () => { screen.getByRole("button", { name: "Block this time instead" }).click(); });
    const end = screen.getByLabelText("Block end");
    await key("ArrowDown", end); await key("ArrowRight", end);
    const search = screen.getByRole("searchbox", { name: /Find a booking/ });
    await key("ArrowLeft", search); await key("ArrowRight", search);
    expect(nav.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add a booking" })).toBeDefined();
  });

  it("Week view: one Tab stop, arrows move between days and times", async () => {
    view({ date: DAY, view: "week", court: courtA.id });
    const first = await screen.findByRole("button", { name: "Add a booking on 2099-01-12 at 08:00" });
    await waitFor(() => expect((first as HTMLButtonElement).disabled).toBe(false));
    const wk = screen.getByRole("group", { name: /^Week,/ });
    expect(Array.from(wk.querySelectorAll<HTMLElement>("button")).filter((b) => b.tabIndex === 0)).toHaveLength(1);
    await act(async () => { first.focus(); });
    await key("ArrowRight"); await key("ArrowDown");
    expect(focused().getAttribute("aria-label")).toBe("Add a booking on 2099-01-13 at 08:30");
  });
});

describe("Phase I-2b review: keyboard at the edges of the day (booking/block ending at closing)", () => {
  const DAY = "2099-01-12";
  const z = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+02:00`).toISOString();
  const late: Booking = { ...booking("b-late", "Late Game"), start_at: z("21:30"), end_at: z("23:00") };          // ends at closing
  const allDay: Block = { id: "k-all", court_id: courtB.id, start_at: z("08:00"), end_at: z("23:00"), reason: "Closed" };
  const focused = () => document.activeElement as HTMLElement;
  const label = () => focused().getAttribute("aria-label");
  const key = async (k: string) => { await act(async () => { fireEvent.keyDown(focused(), { key: k }); }); };
  beforeEach(() => { handler = async () => ok([]); desktop(true); nav.push.mockReset(); });
  afterEach(() => { desktop(false); });

  it("a booking ending at closing: ↓ and End keep focus on it; ↑ leaves it; ← → still move; one Tab stop throughout", async () => {
    view({ date: DAY, bookings: [late], blocks: [allDay] });
    const grid = screen.getByRole("group", { name: /^Courts,/ });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 21:00" }).focus(); });
    await key("ArrowDown");
    expect(label()).toMatch(/^Late Game, Padel 1, 21:30–23:00/);
    for (const k of ["ArrowDown", "ArrowDown", "End"]) {                           // nowhere further down: stays, never lost
      await key(k);
      expect(label()).toMatch(/^Late Game,/);
      expect(grid.contains(focused())).toBe(true);
    }
    expect(Array.from(grid.querySelectorAll<HTMLElement>("button")).filter((b) => b.tabIndex === 0).map((b) => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Late Game,/)]);
    await key("ArrowUp");
    expect(label()).toBe("Add booking Padel 1 21:00");                             // not trapped
    await key("ArrowDown"); await key("ArrowRight");
    expect(label()).toBe("Closed, Padel 2, 08:00–23:00, blocked");
    expect(nav.push).not.toHaveBeenCalled();                                        // the arrows never changed the day
  });

  it("an all-day block: ↑ ↓ Home End stay on it (nothing else in that column), ← → leave it", async () => {
    view({ date: DAY, blocks: [allDay] });
    const grid = screen.getByRole("group", { name: /^Courts,/ });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 12:00" }).focus(); });
    await key("ArrowRight");
    expect(label()).toBe("Closed, Padel 2, 08:00–23:00, blocked");
    for (const k of ["ArrowUp", "ArrowDown", "Home", "End"]) {
      await key(k);
      expect(label()).toBe("Closed, Padel 2, 08:00–23:00, blocked");
      expect(grid.contains(focused())).toBe(true);
    }
    await key("ArrowLeft");
    expect(label()).toBe("Add booking Padel 1 22:30");                              // the block's last row was in use (End)
    await key("ArrowRight"); await key("ArrowRight");                               // past the last court: stays on the block
    expect(label()).toBe("Closed, Padel 2, 08:00–23:00, blocked");
  });

  it("first and last cells: ↑ at opening and ↓ at closing stay put on a free time", async () => {
    view({ date: DAY });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 08:00" }).focus(); });
    await key("ArrowUp"); await key("ArrowLeft");
    expect(label()).toBe("Add booking Padel 1 08:00");
    await key("End"); await key("ArrowDown"); await key("ArrowRight"); await key("ArrowRight");
    expect(label()).toBe("Add booking Padel 2 22:30");
  });

  it("Week view: a booking ending at closing keeps focus with ↓/End; ↑ leaves it", async () => {
    handler = async (q) => ok(q.table === "bookings" ? [late] : []);
    view({ date: DAY, view: "week", court: courtA.id });
    const lastFree = await screen.findByRole("button", { name: "Add a booking on 2099-01-12 at 21:00" });
    await waitFor(() => expect((lastFree as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { lastFree.focus(); });
    await key("ArrowDown");
    expect(label()).toBe("Late Game on 2099-01-12 at 21:30");
    await key("End"); await key("ArrowDown"); await key("ArrowDown");
    expect(label()).toBe("Late Game on 2099-01-12 at 21:30");                       // the 22:30 cell of the same booking
    expect(focused().getAttribute("data-week-cell")).toBe("2099-01-12|22:30");
    await key("ArrowUp"); await key("ArrowUp"); await key("ArrowUp");
    expect(label()).toBe("Add a booking on 2099-01-12 at 21:00");
  });
});

describe("Phase I-2b: customer suggestions by keyboard", () => {
  const guests = [{ name: "Rami Haddad", phone: "+961 3 111 111", last_at: "2026-11-01" }, { name: "Rana Saad", phone: null, last_at: "2026-11-02" }];
  let calls: string[];
  beforeEach(() => { handler = async () => ok([]); desktop(true); calls = []; rpcImpl = async (fn) => { calls.push(fn); return { data: fn === "club_recent_guests" ? guests : [], error: null }; }; });
  afterEach(() => { vi.restoreAllMocks(); desktop(false); rpcImpl = async () => ({ data: [], error: null }); });

  it("↓/↑ highlight, Enter picks (name and phone filled, focus to the length) and never saves; Esc closes only the list", async () => {
    view({ date: "2099-01-12" });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 1 10:00" }).click(); });
    const field = screen.getByRole("combobox", { name: "Customer name" });
    fireEvent.change(field, { target: { value: "Ra" } });
    await screen.findByRole("listbox", { name: "Recent customers" });
    expect(field.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.getAttribute("aria-activedescendant")).toBe("guest-hint-0");
    expect(screen.getByRole("option", { name: /Rami Haddad/ }).getAttribute("aria-selected")).toBe("true");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true);
    expect((field as HTMLInputElement).value).toBe("Rami Haddad");
    expect((screen.getByLabelText("Phone (optional)") as HTMLInputElement).value).toBe("+961 3 111 111");
    expect(calls).not.toContain("staff_book");
    await waitFor(() => expect((document.activeElement as HTMLElement).getAttribute("role")).toBe("radio"));
    // Esc with the list open closes the list and keeps the panel and the details
    fireEvent.change(field, { target: { value: "Ran" } });
    await screen.findByRole("listbox", { name: "Recent customers" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);       // were the panel asked to close, it would
    await act(async () => { fireEvent.keyDown(field, { key: "Escape" }); });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add a booking" })).toBeDefined();
    // Enter with no suggestion highlighted does nothing
    const enter2 = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(enter2); });
    expect(calls).not.toContain("staff_book");
  });
});

describe("Phase I-2b: find a booking on this day", () => {
  const DAY = "2099-01-12";
  const z = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+02:00`).toISOString();
  const rows: Booking[] = [
    { ...booking("f1", "Rami Haddad"), start_at: z("09:00"), end_at: z("10:00"), guest_phone: "+961 3 123 456" },
    { ...booking("f2", "Maya Khoury"), court_id: courtB.id, start_at: z("11:00"), end_at: z("12:00"), guest_phone: null, contact_phone: "70 999 888" },
    { ...booking("f3", "Ramzi Aoun"), start_at: z("18:00"), end_at: z("19:00") },
  ];
  let queries: number;
  beforeEach(() => { queries = 0; handler = async () => { queries++; return ok([]); }; desktop(true); rpcImpl = async () => { queries++; return { data: [], error: null }; }; });
  afterEach(() => { vi.restoreAllMocks(); desktop(false); rpcImpl = async () => ({ data: [], error: null }); });

  it("matches name or phone among the loaded bookings only, highlights them, and opens one; no database read", async () => {
    view({ date: DAY, bookings: rows });
    await act(async () => { await Promise.resolve(); });
    const before = queries;
    const box = screen.getByRole("searchbox", { name: /Find a booking/ });
    fireEvent.change(box, { target: { value: "ram" } });
    const list = screen.getByRole("list", { name: "Matching bookings" });
    expect(Array.from(list.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
      expect.stringContaining("Rami Haddad"), expect.stringContaining("Ramzi Aoun"),
    ]);
    expect(screen.getByText("2 bookings found")).toBeDefined();
    expect(screen.getByRole("button", { name: /^Rami Haddad,/ }).className).toContain("ring-turf");
    expect(screen.getByRole("button", { name: /^Maya Khoury,/ }).className).not.toContain("ring-turf");
    fireEvent.change(box, { target: { value: "999 8" } });                 // phone from club_booking_contacts
    expect(Array.from(screen.getByRole("list", { name: "Matching bookings" }).querySelectorAll("button")).map((b) => b.textContent)).toEqual([expect.stringContaining("Maya Khoury")]);
    expect(queries).toBe(before);                                           // searching read nothing
    // Enter in the box does nothing; ↓ goes to the result; Enter/click opens it; Esc in the box clears it
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { fireEvent.keyDown(box, { key: "ArrowDown" }); });
    expect(document.activeElement?.textContent).toContain("Maya Khoury");
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    expect(screen.getByRole("dialog", { name: "Booking" })).toBeDefined();
    await act(async () => { fireEvent.keyDown(document, { key: "Escape" }); });
    expect(document.activeElement).toBe(box);                               // back to the search box
    await act(async () => { fireEvent.keyDown(box, { key: "Escape" }); });
    expect((box as HTMLInputElement).value).toBe("");
  });

  it("is not offered on phones, in Now or in Week", async () => {
    desktop(false);
    view({ date: DAY, bookings: rows });
    expect(screen.getByRole("searchbox", { name: /Find a booking/ }).parentElement!.className).toContain("hidden lg:block");
    cleanup();
    desktop(true);
    view({ date: DAY, bookings: rows, view: "week", court: courtA.id });
    expect(screen.queryByRole("searchbox", { name: /Find a booking/ })).toBeNull();
  });
});

describe("Phase I-2b: remembered view and sport (desktop)", () => {
  beforeEach(() => { handler = async () => ok([]); nav.replace.mockReset(); window.localStorage.clear(); });
  afterEach(() => { desktop(false); });

  it("an address that names a view is used as is and remembered", async () => {
    desktop(true);
    view({ date: "2099-01-12", view: "week", court: courtA.id, explicit: true });
    await act(async () => { await Promise.resolve(); });
    expect(JSON.parse(window.localStorage.getItem("courtbook:calendar:batroun")!)).toEqual({ view: "week", sport: null });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("a plain address opens on the remembered view", async () => {
    desktop(true);
    window.localStorage.setItem("courtbook:calendar:batroun", JSON.stringify({ view: "list", sport: null }));
    view({ date: "2099-01-12", view: "grid", explicit: false });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining("date=2099-01-12&view=list")));
  });

  it("an explicit address is never overridden, and phones keep today's defaults", async () => {
    window.localStorage.setItem("courtbook:calendar:batroun", JSON.stringify({ view: "list", sport: null }));
    desktop(true);
    view({ date: "2099-01-12", view: "grid", explicit: true });
    await act(async () => { await Promise.resolve(); });
    expect(nav.replace).not.toHaveBeenCalled();
    cleanup();
    desktop(false);
    window.localStorage.setItem("courtbook:calendar:batroun", JSON.stringify({ view: "list", sport: null }));
    view({ date: "2099-01-12", view: "grid", explicit: false });
    await act(async () => { await Promise.resolve(); });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("a remembered Now is used only for today; another day opens on Courts", async () => {
    desktop(true);
    window.localStorage.setItem("courtbook:calendar:batroun", JSON.stringify({ view: "now", sport: null }));
    view({ date: "2099-01-12", view: "list", explicit: false });
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(expect.stringContaining("date=2099-01-12&view=grid")));
  });
});

describe("Phase I-2b: full booking details on hover and keyboard focus", () => {
  const DAY = "2099-01-12";
  const z = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+02:00`).toISOString();
  const long: Booking = { ...booking("b-long", "Alexandrina Montgomery-Haddad"), start_at: z("11:00"), end_at: z("12:00"), guest_phone: "+961 3 555 444" };
  beforeEach(() => { handler = async () => ok([]); desktop(true); });
  afterEach(() => { desktop(false); });

  it("hovering or focusing a booking shows its full details; leaving or blurring hides them", async () => {
    view({ date: DAY, bookings: [long] });
    const b = screen.getByRole("button", { name: /^Alexandrina/ });
    await act(async () => { fireEvent.mouseEnter(b); });
    const peek = screen.getByTestId("peek");
    expect(peek.textContent).toContain("Alexandrina Montgomery-Haddad");
    expect(peek.textContent).toContain("Padel 1 · 11:00–12:00");
    expect(peek.textContent).toContain("Desk booking");
    expect(peek.textContent).toContain("+961 3 555 444");
    expect(peek.getAttribute("aria-hidden")).toBe("true");                  // the button's label says the same in words
    await act(async () => { fireEvent.mouseLeave(b); });
    expect(screen.queryByTestId("peek")).toBeNull();
    await act(async () => { b.focus(); });
    expect(screen.getByTestId("peek").textContent).toContain("Alexandrina Montgomery-Haddad");
    await act(async () => { b.blur(); });
    expect(screen.queryByTestId("peek")).toBeNull();
    expect(b.getAttribute("aria-label")).toBe("Alexandrina Montgomery-Haddad, Padel 1, 11:00–12:00, desk booking, +961 3 555 444");
  });
});

describe("Phase I-2b: details of a long block appear beside the row in use, not off-screen", () => {
  beforeEach(() => { handler = async () => ok([]); desktop(true); });
  afterEach(() => { desktop(false); });
  it("keyboard on an all-day block at 18:00: the details sit just below 18:00", async () => {
    const DAY = "2099-01-12";
    const z = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+02:00`).toISOString();
    view({ date: DAY, blocks: [{ id: "k-day", court_id: courtA.id, start_at: z("08:00"), end_at: z("23:00"), reason: "Tournament" }] });
    const slot18 = screen.getByRole("button", { name: "Add booking Padel 2 18:00" });     // row 20
    await act(async () => { slot18.focus(); });
    await act(async () => { fireEvent.keyDown(slot18, { key: "ArrowLeft" }); });
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Tournament, Padel 1, 08:00–23:00, blocked");
    expect(screen.getByTestId("peek").style.top).toBe(`${21 * 36 + 2}px`);                // 30-min grid rows are 36 px
  });
});

describe("Phase I-2b: accessibility scan (axe-core)", () => {
  beforeEach(() => { handler = async () => ok([]); desktop(true); rpcImpl = async (fn) => ({ data: fn === "club_recent_guests" ? [{ name: "Rami Haddad", phone: null, last_at: "2026-11-01" }] : [], error: null }); });
  afterEach(() => { desktop(false); rpcImpl = async () => ({ data: [], error: null }); });
  const scan = async () => {
    const axe = (await import("axe-core")).default;
    // colour contrast cannot be computed without a real layout engine
    const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    return r.violations.map((v) => `${v.id}: ${v.nodes.length}`);
  };

  it("Courts view with bookings, a block, search results and the add form with suggestions: no violations", async () => {
    const DAY = "2099-01-12";
    const z = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+02:00`).toISOString();
    view({ date: DAY, bookings: [{ ...booking("a1", "Rami Haddad"), start_at: z("11:00"), end_at: z("12:00") }],
           blocks: [{ id: "k1", court_id: courtB.id, start_at: z("10:00"), end_at: z("12:00"), reason: "Net repair" }] });
    fireEvent.change(screen.getByRole("searchbox", { name: /Find a booking/ }), { target: { value: "ram" } });
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 2 15:00" }).click(); });
    fireEvent.change(screen.getByRole("combobox", { name: "Customer name" }), { target: { value: "Ra" } });
    await screen.findByRole("listbox", { name: "Recent customers" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Customer name" }), { key: "ArrowDown" });
    expect(await scan()).toEqual([]);
  });

  it("Week view: no violations", async () => {
    view({ date: "2099-01-12", view: "week", court: courtA.id });
    await screen.findByRole("group", { name: /^Week,/ });
    expect(await scan()).toEqual([]);
  });
});
