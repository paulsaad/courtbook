// @vitest-environment jsdom
/**
 * Club page time grid for screen readers (Session B's axe run, 26 Nov: 150 slot buttons without a name, "button-name",
 * critical). Each slot now says its court, time and state; the selected one is pressed; axe finds no unnamed button.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { formatInTimeZone } from "date-fns-tz";
import axe from "axe-core";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async () => ({ data: 20, error: null }),
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq", "in", "gte", "lt", "gt", "order", "or", "not"]) b[m] = () => b; b.maybeSingle = async () => ({ data: null, error: null }); b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r); return b; },
  }),
}));
import PlayerGrid from "./PlayerGrid";

const TZ = "Asia/Beirut";
const tomorrow = formatInTimeZone(new Date(Date.now() + 24 * 3600_000), TZ, "yyyy-MM-dd");
const at = (hhmm: string) => new Date(`${tomorrow}T${hhmm}:00+02:00`).toISOString();
const club = { id: "c1", name: "Test Club", slug: "test", active: true, timezone: TZ, open_time: "08:00", close_time: "23:00",
  slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 180, cancel_cutoff_hours: 6, hold_minutes: 10,
  booking_window_days: 14, service_fee_usd: 0, location_url: null, payment_mode: "at_desk", is_demo: false } as never;
const COURTS = [{ id: "k1", club_id: "c1", name: "Padel 1", sport: "padel", active: true, sort: 1 }] as never;
const OCC = [{ id: "o1", court_id: "k1", start_at: at("18:00"), end_at: at("19:00"), status: "confirmed", mine: false, kind: "booking" }] as never;
Element.prototype.scrollIntoView = function () {};
afterEach(cleanup);

const show = () => render(<PlayerGrid signedIn club={club} courts={COURTS} occ={OCC} occError={false} date={tomorrow} hold={null} preselect={null} sportNames={{ padel: "Padel" }} />);

describe("club page time grid: every slot has a name (screen readers)", () => {
  it("free, booked and too-short slots say so; the court and time come first", () => {
    show();
    expect(screen.getByRole("button", { name: "Padel 1, 10:00, free" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Padel 1, 18:00, booked" }) as HTMLButtonElement).disabled).toBe(true);
    // 17:30 is free but only 30 min before the booking, below the club's 1 h minimum
    expect((screen.getByRole("button", { name: "Padel 1, 17:30, too short to book" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the chosen slot is pressed and says 'selected'", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Padel 1, 10:00, free" }));
    const sel = screen.getByRole("button", { name: "Padel 1, 10:00, selected" });
    expect(sel.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Padel 1, 11:00, free" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("axe: no button without a name", async () => {
    const { container } = show();
    const r = await axe.run(container, { runOnly: { type: "rule", values: ["button-name"] } });
    expect(r.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
  });
});
