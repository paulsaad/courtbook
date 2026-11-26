// @vitest-environment jsdom
/**
 * Session B's round-3/4 handover (26 Nov):
 *  - H14: "Yes, cancel" tapped again after a cancel whose answer was lost is refused ("This booking is no longer
 *    active.") while the page still offered cancel, share and open-to-players. The page now refreshes on that
 *    refusal and shows the booking as it is. A dropped connection still reloads nothing (W5).
 *  - H9 on the M12 line: a cancelled booking whose fee was paid online (fee_only) must not say to pay the court at the club.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const router = { replace: vi.fn(), refresh: vi.fn() };
let answers: { data: unknown; error: unknown }[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async () => answers.shift() ?? { data: null, error: null } }),
}));

// the booking page's server reads
let booking: Record<string, unknown> = {};
let payment: Record<string, unknown> | null = null;
const ok = (data: unknown) => ({ data, error: null });
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async () => ok([]),
    from: (table: string) => {
      const answer = table === "bookings" ? ok(booking) : table === "payments" ? ok(payment) : table === "sports" ? ok([{ code: "padel", name_en: "Padel" }]) : ok(null);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order"]) b[m] = () => b;
      b.single = async () => answer; b.maybeSingle = async () => answer;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res);
      return b;
    },
  }),
}));

import BookingPage from "./page";

beforeEach(() => { answers = []; router.replace.mockReset(); router.refresh.mockReset(); payment = null; });
afterEach(cleanup);

describe("H9 on the M12 line: fee paid online, court at the club", () => {
  const future = new Date(Date.now() + 3 * 86400_000);
  const make = (status: string) => ({
    id: "04692734-bb44-4d88-a171-fe1854f2c332", club_id: "c1", status, price_usd: 20, fee_usd: 1, cancelled_at: null,
    start_at: future.toISOString(), end_at: new Date(future.getTime() + 3600_000).toISOString(),
    clubs: { name: "Batroun Padel & Tennis Club", slug: "batroun", timezone: "Asia/Beirut", cancel_cutoff_hours: 6, location_url: null, payment_mode: "fee_online", lat: null, lng: null },
    courts: { name: "Padel 2", sport: "padel" },
  });
  const page = async () => render(await BookingPage({ params: Promise.resolve({ id: "04692734-bb44-4d88-a171-fe1854f2c332" }), searchParams: Promise.resolve({}) }));

  it("confirmed: fee paid online, court paid at the club when you arrive (unchanged)", async () => {
    booking = make("confirmed"); payment = { kind: "fee_only", status: "paid", total_usd: 1 };
    await page();
    expect(screen.getByText("Booking fee, paid online")).toBeTruthy();
    expect(screen.getByText("Pay at the club")).toBeTruthy();
    expect(screen.getByText(/paid to Batroun Padel & Tennis Club when you arrive/)).toBeTruthy();
  });
  it("cancelled by the player (fee kept): no pay-at-club line, no 'when you arrive'", async () => {
    booking = make("cancelled"); payment = { kind: "fee_only", status: "paid", total_usd: 1 };
    await page();
    expect(screen.getByText("Booking fee, paid online")).toBeTruthy();
    expect(screen.queryByText("Pay at the club")).toBeNull();
    expect(screen.queryByText(/when you arrive/)).toBeNull();
  });
  it("cancelled by the club: the fee refund is still said", async () => {
    booking = make("cancelled"); payment = { kind: "fee_only", status: "refund_due", total_usd: 1 };
    await page();
    expect(screen.getByText("The booking fee is being refunded.")).toBeTruthy();
    expect(screen.queryByText("Pay at the club")).toBeNull();
  });
});
