// @vitest-environment jsdom
/**
 * Review of #73: Reserve now reads the player's details before booking. While that read is out (here: held open
 * on purpose), the booked court, start and length must be exactly what was tapped; a changed selection books
 * nothing; a second tap starts nothing. The app does the same (mobile/__tests__/reserveDetails.test.tsx, #70).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { formatInTimeZone } from "date-fns-tz";

type Res = { data: unknown; error: unknown };
const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
let profileReads = 0;
let nextProfile: () => Promise<Res> = async () => ({ data: { name: "Rana", phone: "+96170123456" }, error: null });
let bookAnswer: () => Res = () => ({ data: [{ booking_id: "b1" }], error: null });
const booked: Record<string, unknown>[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "book_at_desk" || fn === "hold_slot") { booked.push({ fn, ...args }); return bookAnswer(); }
      return { data: 20, error: null };
    },
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "lt", "gt", "order", "or", "not"]) b[m] = () => b;
      b.maybeSingle = async () => { if (t !== "profiles") return { data: null, error: null }; profileReads++; return nextProfile(); };
      b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
      return b;
    },
  }),
}));
import PlayerGrid from "./PlayerGrid";

const TZ = "Asia/Beirut";
const tomorrow = formatInTimeZone(new Date(Date.now() + 24 * 3600_000), TZ, "yyyy-MM-dd");
const at = (hhmm: string) => new Date(`${tomorrow}T${hhmm}:00+02:00`).toISOString();   // Beirut is UTC+2 in winter
const club = { id: "c1", name: "Test Club", slug: "test", active: true, timezone: TZ, open_time: "08:00", close_time: "23:00",
  slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 180, cancel_cutoff_hours: 6, hold_minutes: 10,
  booking_window_days: 14, service_fee_usd: 0, location_url: null, payment_mode: "at_desk", is_demo: false } as never;
const COURTS = [{ id: "k1", club_id: "c1", name: "Court 1", sport: "padel", active: true, sort: 1 }] as never;
Element.prototype.scrollIntoView = function () {};

function held() {
  let open!: (v: Res) => void;
  const p = new Promise<Res>((r) => { open = r; });
  nextProfile = () => p;
  return (v: Res = { data: { name: "Rana", phone: "+96170123456" }, error: null }) => act(async () => { open(v); await p; });
}
beforeEach(() => {
  profileReads = 0; booked.length = 0; nav.push.mockReset(); nav.refresh.mockReset();
  nextProfile = async () => ({ data: { name: "Rana", phone: "+96170123456" }, error: null });
  bookAnswer = () => ({ data: [{ booking_id: "b1" }], error: null });
});
afterEach(cleanup);

function show() {
  const { container } = render(<PlayerGrid signedIn club={club} courts={COURTS} occ={[]} occError={false} date={tomorrow} hold={null} preselect={null} sportNames={{ padel: "Padel" }} />);
  return container;
}
const cell = (container: HTMLElement, i: number) => container.querySelectorAll<HTMLButtonElement>("button.absolute")[i];   // 08:00 + i × 30 min
async function reserveButton() {
  const dialog = screen.getByRole("dialog");
  return waitFor(() => {
    const b = within(dialog).getAllByRole("button").find((x) => /Reserve/.test(x.textContent ?? "") && !(x as HTMLButtonElement).disabled);
    if (!b) throw new Error("Reserve not ready");
    return b;
  });
}
/** Two taps handled before React renders again: both run the handler of the same render (busy still false). */
function twoTapsInOneFrame(button: HTMLElement) {
  const props = Object.entries(button).find(([k]) => k.startsWith("__reactProps"))?.[1] as { onClick: () => void } | undefined;
  if (!props) throw new Error("no React props on the button");
  act(() => { props.onClick(); props.onClick(); });
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe("club page Reserve while the details are read (review of #73)", () => {
  it("unchanged selection: exactly the tapped court, start and length are booked", async () => {
    const c = show();
    fireEvent.click(cell(c, 4));                                     // 10:00, 1 h by default
    const release = held();
    fireEvent.click(await reserveButton());
    await settle();
    expect(booked).toEqual([]);                                      // nothing sent before the details answer
    await release();
    await waitFor(() => expect(booked).toHaveLength(1));
    expect(booked[0]).toMatchObject({ fn: "book_at_desk", p_court: "k1", p_start: at("10:00"), p_end: at("11:00") });
    expect(nav.push).toHaveBeenCalledWith("/bookings/b1?new=1");
  });

  it("the player picks another time while the details load: nothing is booked, the new time can be reserved", async () => {
    const c = show();
    fireEvent.click(cell(c, 4));                                     // 10:00
    const release = held();
    fireEvent.click(await reserveButton());
    fireEvent.click(cell(c, 8));                                     // 12:00 meanwhile
    await release();
    await settle();
    expect(booked).toEqual([]);                                      // neither 10:00 (changed) nor 12:00 (never tapped)
    expect(nav.push).not.toHaveBeenCalled();
    nextProfile = async () => ({ data: { name: "Rana", phone: "+96170123456" }, error: null });
    fireEvent.click(await reserveButton());                          // Reserve is free again, for 12:00
    await waitFor(() => expect(booked).toHaveLength(1));
    expect(booked[0]).toMatchObject({ p_start: at("12:00"), p_end: at("13:00") });
  });

  it("the player changes the length while the details load: nothing is booked", async () => {
    const c = show();
    fireEvent.click(cell(c, 4));
    const release = held();
    fireEvent.click(await reserveButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "1 h 30" }));
    await release();
    await settle();
    expect(booked).toEqual([]);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("a second tap while the details load starts nothing more: one read, one booking", async () => {
    const c = show();
    fireEvent.click(cell(c, 4));
    const release = held();
    twoTapsInOneFrame(await reserveButton());                        // the second lands before the button shows "busy"
    await release();
    await waitFor(() => expect(booked).toHaveLength(1));
    await settle();
    expect(profileReads).toBe(1);
    expect(booked).toHaveLength(1);
  });

  it("a retry of the same selection reuses its token; another selection gets a new one", async () => {
    bookAnswer = () => ({ data: null, error: { message: "Failed to fetch" } });   // the answer is lost
    const c = show();
    fireEvent.click(cell(c, 4));
    fireEvent.click(await reserveButton());
    await waitFor(() => expect(booked).toHaveLength(1));
    fireEvent.click(await reserveButton());                          // same selection again
    await waitFor(() => expect(booked).toHaveLength(2));
    expect(booked[1].p_token).toBe(booked[0].p_token);
    fireEvent.click(cell(c, 8));                                     // another time
    fireEvent.click(await reserveButton());
    await waitFor(() => expect(booked).toHaveLength(3));
    expect(booked[2].p_token).not.toBe(booked[0].p_token);
  });
});
