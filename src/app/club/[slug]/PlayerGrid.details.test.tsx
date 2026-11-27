// @vitest-environment jsdom
/**
 * Reserve on the club page: a player without a name or contact phone goes to the details step (with this exact
 * selection to come back to) and nothing is booked; a complete profile books; unreadable details book nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { formatInTimeZone } from "date-fns-tz";

const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
let me: { data: unknown; error: unknown } = { data: { name: "Rana", phone: null }, error: null };
let rpcs: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async (fn: string) => { rpcs.push(fn); return fn === "book_at_desk" ? { data: [{ booking_id: "b1" }], error: null } : { data: 20, error: null }; },
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "lt", "gt", "order", "or", "not"]) b[m] = () => b;
      b.maybeSingle = async () => (t === "profiles" ? me : { data: null, error: null });
      b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r);
      return b;
    },
  }),
}));
import PlayerGrid from "./PlayerGrid";

const TZ = "Asia/Beirut";
const tomorrow = formatInTimeZone(new Date(Date.now() + 24 * 3600_000), TZ, "yyyy-MM-dd");
const club = { id: "c1", name: "Test Club", slug: "test", active: true, timezone: TZ, open_time: "08:00", close_time: "23:00",
  slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 180, cancel_cutoff_hours: 6, hold_minutes: 10,
  booking_window_days: 14, service_fee_usd: 0, location_url: null, payment_mode: "at_desk", is_demo: false } as never;
const COURTS = [{ id: "k1", club_id: "c1", name: "Court 1", sport: "padel", active: true, sort: 1 }] as never;
Element.prototype.scrollIntoView = function () {};
beforeEach(() => { rpcs = []; nav.push.mockReset(); });
afterEach(cleanup);

async function reserveAtTen() {
  const { container } = render(<PlayerGrid signedIn club={club} courts={COURTS} occ={[]} occError={false} date={tomorrow} hold={null} preselect={null} sportNames={{ padel: "Padel" }} />);
  fireEvent.click(container.querySelectorAll<HTMLButtonElement>("button.absolute")[4]);
  const dialog = screen.getByRole("dialog");
  const btn = await waitFor(() => { const b = within(dialog).getAllByRole("button").find((x) => /Reserve/.test(x.textContent ?? "") && !(x as HTMLButtonElement).disabled); if (!b) throw new Error("no reserve yet"); return b; });
  fireEvent.click(btn);
  return dialog;
}

describe("club page Reserve: name and contact phone before a first booking", () => {
  it("no phone: goes to the details step with this selection, and books nothing", async () => {
    me = { data: { name: "Rana", phone: null }, error: null };
    await reserveAtTen();
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const to = decodeURIComponent(String(nav.push.mock.calls[0][0]));
    expect(to).toMatch(/^\/details\?next=\/club\/test\?at=.+&court=k1&dur=60$/);
    expect(rpcs.filter((r) => r === "book_at_desk" || r === "hold_slot")).toEqual([]);
  });
  it("complete profile: books as before", async () => {
    me = { data: { name: "Rana", phone: "+96170123456" }, error: null };
    await reserveAtTen();
    await waitFor(() => expect(rpcs).toContain("book_at_desk"));
    expect(nav.push.mock.calls.some(([u]) => String(u).startsWith("/details"))).toBe(false);
  });
  it("details unreadable: says so, books nothing", async () => {
    me = { data: null, error: { message: "Failed to fetch" } };
    const dialog = await reserveAtTen();
    await waitFor(() => expect(dialog.textContent).toContain("Couldn't check your details"));
    expect(rpcs.filter((r) => r === "book_at_desk" || r === "hold_slot")).toEqual([]);
    expect(nav.push).not.toHaveBeenCalled();
  });
});
