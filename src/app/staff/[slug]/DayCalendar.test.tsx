// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

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
    expect(onSave).toHaveBeenCalledWith("", "", 2, true, "10:00");       // reason empty, not "Ali Haddad"
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
    expect(onSave).toHaveBeenCalledWith("Net repair", "", 2, true, "10:00");
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
const typeName = (v: string) => fireEvent.change(screen.getByRole("textbox", { name: "Customer name" }), { target: { value: v } });

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
    expect((screen.getByRole("textbox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
    expect(screen.getByRole("heading", { name: /Padel 1, 10:00/ })).toBeDefined();
    confirm.mockReturnValueOnce(true);
    await act(async () => { screen.getByRole("button", { name: "Add booking Padel 2 11:00" }).click(); });
    expect(screen.getByRole("heading", { name: /Padel 2, 11:00/ })).toBeDefined();
    expect((screen.getByRole("textbox", { name: "Customer name" }) as HTMLInputElement).value).toBe("");
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
    const nameField = screen.getByRole("textbox", { name: "Customer name" });
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
    expect((screen.getByRole("textbox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
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
      expect((screen.getByRole("textbox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
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
    const field = screen.getByRole("textbox", { name: "Customer name" });
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
    expect((screen.getByRole("textbox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
    expect((screen.getByPlaceholderText("Phone (optional)") as HTMLInputElement).value).toBe("03 123 456");
    await act(async () => { resizeTo(start); });
    expect((screen.getByRole("textbox", { name: "Customer name" }) as HTMLInputElement).value).toBe("Rami");
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
    expect(screen.queryByRole("button", { name: "Net repair" })).toBeNull();
    const saved: Block = { id: "blk-1", court_id: courtA.id, start_at: z("10:00"), end_at: z("14:00"), reason: "Net repair" };
    handler = async (q) => ok(q.table === "blocks" ? [saved] : []);
    await act(async () => { answer.settle({ data: "blk-1", error: null }); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Net repair" })).toBeDefined());
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
