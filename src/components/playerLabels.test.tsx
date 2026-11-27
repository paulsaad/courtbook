// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * Player QA, 26 Nov: the website showed database codes ("padel · All levels welcome", "football") on a game's card,
 * and "Batroun · Batroun" on the Courts list. The app shows "Padel" and "Batroun".
 */
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string) => (fn === "club_day_slots" ? { data: ROWS, error: null } : { data: null, error: { code: "PGRST202", message: "Could not find the function" } }),
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }), in: async () => ({ data: [], error: null }) }) }),
  }),
}));
const { MatchCard } = await import("./MatchBoard");
const CourtsDay = (await import("@/app/courts/CourtsDay")).default;

const slot = (id: string, name: string, town: string, district: string) => ({ club_id: id, club_name: name, slug: id, town, district, price_from: 20, sports: ["padel"], slot_minutes: 30, min_minutes: 60, max_minutes: 120,
  service_fee_usd: 0, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut", court_id: `${id}-c`, court_name: "Court 1", court_sport: "padel", start_at: "2026-11-24T16:00:00Z", free_minutes: 120, is_demo: false, payment_mode: "at_desk" });
const ROWS = [slot("bat", "Batroun Club", "Batroun", "Batroun"), slot("kou", "Koura Club", "Amioun", "Koura")];
afterEach(cleanup);

const match = { match_id: "m1", club_id: "c1", club_name: "Batroun Club", club_slug: "bat", sport: "football", start_at: "2026-11-28T17:00:00Z", end_at: "2026-11-28T18:30:00Z",
  level_min: null, level_max: null, level_legacy: false, my_level: null, players_needed: 10, joined: 0, pending: 0, status: "open", closed_reason: null,
  organizer_id: "o1", organizer_name: "Karim", my_status: null, i_organize: false, booking_id: null, court_name: null, note: null, join_mode: "open" };

describe("a game's card (match page and club board)", () => {
  it("names the sport in words, not the database code", () => {
    render(<MatchCard m={match} tz="Asia/Beirut" />);
    expect(screen.getByText(/^Football · /)).toBeTruthy();
    expect(screen.queryByText(/^football · /)).toBeNull();
  });
});

describe("Courts list place line", () => {
  it("a town named like its district is said once; different names both", async () => {
    window.history.replaceState(null, "", "/courts");
    Element.prototype.scrollIntoView = () => {};
    render(<CourtsDay areas={[]} sports={[{ code: "padel", name_en: "Padel", name_ar: "", sort_order: 1, active: true }]} today="2026-11-24" date="2026-11-24" query="" initial={ROWS} initialError={false} signedIn={false} resume={null} />);
    await screen.findByText("Batroun Club");
    const lines = screen.getAllByText(/from \$20\/h/).map((e) => e.textContent);
    expect(lines.some((t) => /^Batroun · from \$20\/h/.test(t ?? ""))).toBe(true);
    expect(lines.some((t) => /Batroun · Batroun/.test(t ?? ""))).toBe(false);
    expect(lines.some((t) => /^Amioun · Koura · from \$20\/h/.test(t ?? ""))).toBe(true);
  });
});
