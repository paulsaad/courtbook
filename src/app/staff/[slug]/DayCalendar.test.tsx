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
    expect(onSave).toHaveBeenCalledWith("", "", 2, true);       // reason empty, not "Ali Haddad"
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
    expect(onSave).toHaveBeenCalledWith("Net repair", "", 2, true);
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

