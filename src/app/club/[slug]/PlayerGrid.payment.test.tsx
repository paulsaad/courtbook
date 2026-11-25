// @vitest-environment jsdom
/**
 * W1 (pilot visual audit, 25 Nov): the club page's booking panel at a club that takes payment at its desk promised
 * "+ booking fee $1.00", a $21 total, "Reserve and pay" and a 10-minute hold, while the booking it makes is confirmed
 * at once with no fee and nothing paid in the app. The panel now follows the club's payment mode.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { formatInTimeZone } from "date-fns-tz";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: 20, error: null }),   // the court price quote: $20 for the hour
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq", "in", "gte", "lt", "gt", "order", "or", "not"]) b[m] = () => b; b.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r); return b; },
  }),
}));

import PlayerGrid from "./PlayerGrid";

const TZ = "Asia/Beirut";
const tomorrow = formatInTimeZone(new Date(Date.now() + 24 * 3600_000), TZ, "yyyy-MM-dd");
const club = (payment_mode: string) => ({
  id: "c1", name: "Test Club", slug: "test", active: true, timezone: TZ, open_time: "08:00", close_time: "23:00",
  slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 180, cancel_cutoff_hours: 6, hold_minutes: 10,
  booking_window_days: 14, service_fee_usd: 1, location_url: null, payment_mode, is_demo: false,
}) as never;
const COURTS = [{ id: "k1", club_id: "c1", name: "Court 1", sport: "padel", active: true, sort: 1 }] as never;

async function panel(mode: string) {
  render(<PlayerGrid signedIn club={club(mode)} courts={COURTS} occ={[]} occError={false} date={tomorrow} hold={null}
    preselect={{ date: tomorrow, time: "10:00", courtId: "k1", minutes: 60 }} sportNames={{ padel: "Padel" }} />);
  const dialog = screen.getByRole("dialog");
  await waitFor(() => expect(within(dialog).getByText("$20.00", { exact: false })).toBeTruthy());
  return dialog.textContent ?? "";
}

Element.prototype.scrollIntoView = function () {};
afterEach(cleanup);

describe("club page booking panel and the club's payment mode (W1)", () => {
  it("pay at the desk: the court price only, no fee, no paying in the app, no hold", async () => {
    const text = await panel("at_desk");
    expect(text).toContain("Pay at the club");
    expect(text).toContain("$20.00");
    expect(text).toContain("Reserve — you pay at the club");
    expect(text).toContain("nothing is paid through the app");
    expect(text).not.toMatch(/booking fee|\$21\.00|Reserve and pay|while you pay/);
  });
  it("paid in the app (simulated): court + fee, the total and the hold are shown", async () => {
    const text = await panel("simulated");
    expect(text).toContain("Court $20.00 + booking fee $1.00");
    expect(text).toContain("$21.00");
    expect(text).toContain("Reserve and pay $21.00");
    expect(text).toContain("Slot held 10 minutes while you pay");
  });
});
