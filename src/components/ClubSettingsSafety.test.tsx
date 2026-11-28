// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const calls: Array<[string, unknown]> = [];
let rpcAnswer: { data: unknown; error: { message: string } | null } = { data: 2, error: null };
let writeError: { message: string } | null = null;
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: unknown) => { calls.push([`rpc:${fn}`, args]); return rpcAnswer; },
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      b.update = (v: unknown) => { calls.push([`update:${t}`, v]); return b; };
      b.delete = () => { calls.push([`delete:${t}`, null]); return b; };
      b.insert = (v: unknown) => { calls.push([`insert:${t}`, v]); return b; };
      b.eq = () => b; b.select = () => b; b.order = () => b;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: writeError }).then(res);
      return b;
    },
  }),
}));
const ClubSettings = (await import("./ClubSettings")).default;

const club = { id: "c", name: "Club", slug: "club", active: false, service_fee_usd: 1, open_time: "08:00", close_time: "23:00", slot_minutes: 30, min_booking_minutes: 60,
  max_booking_minutes: 180, cancel_cutoff_hours: 6, hold_minutes: 10, booking_window_days: 14, location_url: null, town_id: null, lat: null, lng: null };
const rule = { id: "r1", court_id: null, weekday_mask: 127, start_time: "08:00:00", end_time: "23:00:00", price_usd: 20, label: null };
const court = { id: "k1", name: "Padel 1", sport: "padel", surface: null, sort: 1, active: true };
const view = (rules: unknown[] = []) => render(<ClubSettings club={club as never} courts={[court] as never} rules={rules as never} staff={[]} coaches={[]} isAdmin={false} backHref="/"
  areas={[]} sports={[{ code: "padel", name_en: "Padel" } as never]} town={null} media={[]} readiness={null} />);

beforeEach(() => { calls.length = 0; rpcAnswer = { data: 2, error: null }; writeError = null; });
afterEach(cleanup);

describe("quick set-up: one price for all opening hours (0092)", () => {
  it("a new club: base price and a peak are sent to the database in one call; nothing replaced", async () => {
    view();
    fireEvent.change(screen.getByLabelText("Price per hour ($)"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a peak time" }));
    fireEvent.change(screen.getByLabelText("Peak 1 price per hour in dollars"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Peak 1 on Monday" }));   // weekends and Tue–Fri only
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set prices" })); });
    const sent = calls.find(([k]) => k === "rpc:set_club_base_prices");
    expect(sent?.[1]).toEqual({ p_club: "c", p_base: 20, p_replace: false, p_peaks: [{ start: "18:00", end: "23:00", price: 30, days: 126 }] });
  });
  it("whole-club prices exist: cannot be set until 'Replace' is ticked, then replaces on purpose", async () => {
    view([rule]);
    fireEvent.change(screen.getByLabelText("Price per hour ($)"), { target: { value: "22" } });
    const set = screen.getByRole("button", { name: "Set prices" }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Replace the current whole-club prices/ }));
    expect(set.disabled).toBe(false);
    await act(async () => { fireEvent.click(set); });
    expect(calls.find(([k]) => k === "rpc:set_club_base_prices")?.[1]).toMatchObject({ p_base: 22, p_replace: true });
  });
  it("a refusal is shown in words (e.g. overlapping peaks)", async () => {
    rpcAnswer = { data: null, error: { message: "peaks_overlap" } };
    view();
    fireEvent.change(screen.getByLabelText("Price per hour ($)"), { target: { value: "20" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Set prices" })); });
    expect(screen.getByText(/Two peak times overlap/)).toBeTruthy();
  });
});

describe("destructive changes ask first (0092)", () => {
  it("deleting a price: one tap only asks; nothing is deleted until confirmed; Keep cancels", async () => {
    view([rule]);
    fireEvent.click(screen.getByRole("button", { name: /Delete the price 08:00–23:00/ }));
    expect(calls.some(([k]) => k === "delete:price_rules")).toBe(false);
    expect(screen.getByRole("alert").textContent).toMatch(/times players cannot book/);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("button", { name: "Delete this price" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Delete the price 08:00–23:00/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete this price" })); });
    expect(calls.some(([k]) => k === "delete:price_rules")).toBe(true);
  });
  it("deactivating a court: asks first and explains; only the confirm sends it", async () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    expect(calls.some(([k]) => k === "update:courts")).toBe(false);
    expect(screen.getByRole("alert").textContent).toMatch(/upcoming bookings can't be deactivated/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Deactivate Padel 1" })); });
    expect(calls.find(([k]) => k === "update:courts")?.[1]).toEqual({ active: false });
  });
  it("UI-1: a refusal is brought into view and announced, not left at the top of the page", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    writeError = { message: "court_has_bookings" };
    view();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Deactivate Padel 1" })); });
    const box = screen.getAllByRole("alert").find((e) => /still has upcoming bookings/.test(e.textContent ?? ""));
    expect(box).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.contexts[0]).toBe(box);
  });
});
