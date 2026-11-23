// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** "Near me" on the website's Courts page: asks only on a tap, never sends the position, sorts nearest first. */
const sent: unknown[] = [];
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string, args?: unknown) => { sent.push([fn, args]); return fn === "club_day_slots" ? { data: ROWS, error: null } : { data: null, error: { code: "PGRST202", message: "Could not find the function" } }; },
    from: (t: string) => ({ select: (cols: string) => ({ eq: async (c: string, v: unknown) => { sent.push(["from", t, cols, c, v]); return { data: [{ id: "far", lat: 34.4367, lng: 35.8497 }, { id: "near", lat: 33.8938, lng: 35.5018 }], error: null }; } }) }),
  }),
}));
const CourtsDay = (await import("./CourtsDay")).default;

const slot = (id: string, name: string) => ({ club_id: id, club_name: name, slug: id, town: null, district: null, price_from: null, sports: ["padel"], slot_minutes: 30, min_minutes: 60, max_minutes: 120,
  service_fee_usd: 1, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut", court_id: `${id}-c`, court_name: "Court 1", court_sport: "padel", start_at: "2026-11-24T16:00:00Z", free_minutes: 120, is_demo: false });
const ROWS = [slot("far", "Tripoli Club"), slot("near", "Beirut Club")];
const ME = { latitude: 33.8886, longitude: 35.4955 };   // in Beirut
let getCurrentPosition: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};   // jsdom has none
  sent.length = 0; localStorage.clear();
  getCurrentPosition = vi.fn((ok: (p: unknown) => void) => ok({ coords: ME }));
  Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition }, configurable: true });
  Object.defineProperty(navigator, "permissions", { value: { query: vi.fn(async () => ({ state: "granted" })) }, configurable: true });
  window.history.replaceState(null, "", "/courts");
});
afterEach(cleanup);
const mount = () => render(<CourtsDay areas={[]} sports={[{ code: "padel", name_en: "Padel", name_ar: "", sort_order: 1, active: true }]} today="2026-11-24" date="2026-11-24" query="" initial={ROWS} initialError={false} signedIn={false} resume={null} />);
const names = () => screen.getAllByRole("article").map((a) => a.querySelector(".text-\\[17px\\]")?.textContent);

describe("Near me (website)", () => {
  it("never asks for location on load", async () => {
    mount();
    await screen.findByText("Tripoli Club");
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });
  it("a tap asks once (coarse), sorts nearest first with straight-line distances, and never sends the position", async () => {
    mount();
    await screen.findByText("Tripoli Club");
    fireEvent.click(screen.getByRole("button", { name: "Near me" }));
    await waitFor(() => expect(names()).toEqual(["Beirut Club", "Tripoli Club"]));
    expect(getCurrentPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: false });
    expect(screen.getByText(/straight-line/)).toBeTruthy();
    expect(screen.getAllByText(/km ·/).map((e) => e.textContent)).toEqual(["Under 1 km · ", "69 km · "]);
    const everything = JSON.stringify(sent);
    expect(everything).not.toMatch(/33\.88|35\.49|33\.89,|latitude/);   // the player's position is nowhere in what was sent
    expect(localStorage.getItem("cb_near")).toBe("1");                 // only the choice is remembered
    expect(JSON.stringify(localStorage)).not.toMatch(/33\.8|35\.4/);
  });
  it("refused: says so and points to areas; nothing remembered", async () => {
    getCurrentPosition = vi.fn((_ok: unknown, err: (e: unknown) => void) => err({ code: 1 }));
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition }, configurable: true });
    mount();
    await screen.findByText("Tripoli Club");
    fireEvent.click(screen.getByRole("button", { name: "Near me" }));
    expect(await screen.findByText(/Location is off for CourtBook in this browser\. Choose an area instead/)).toBeTruthy();
    expect(localStorage.getItem("cb_near")).toBeNull();
  });
  it("chosen before and already allowed: resumes without asking the player again (no prompt)", async () => {
    localStorage.setItem("cb_near", "1");
    mount();
    await waitFor(() => expect(names()).toEqual(["Beirut Club", "Tripoli Club"]));
  });
  it("chosen before but no longer allowed: stays off, no prompt", async () => {
    localStorage.setItem("cb_near", "1");
    Object.defineProperty(navigator, "permissions", { value: { query: vi.fn(async () => ({ state: "prompt" })) }, configurable: true });
    mount();
    await screen.findByText("Tripoli Club");
    await new Promise((r) => setTimeout(r, 20));
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });
});

describe("Near me versus the remembered area (M14 review B, website)", () => {
  // browsing Beirut (remembered in this browser), standing in Batroun
  const BATROUN = { latitude: 34.2553, longitude: 35.6586 };
  const slotsArgs = () => sent.filter((c) => Array.isArray(c) && c[0] === "club_day_slots").map((c) => (c as [string, Record<string, unknown>])[1]);
  beforeEach(() => {
    localStorage.setItem("cb_prefs", JSON.stringify({ sport: null, gov: "beirut", district: null, town: null, townName: null }));
    getCurrentPosition = vi.fn((ok: (p: unknown) => void) => ok({ coords: BATROUN }));
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition }, configurable: true });
  });
  it("Near me asks the server for every area, nearest first; turning it off returns to Beirut", async () => {
    mount();
    await waitFor(() => expect(slotsArgs().at(-1)).toMatchObject({ p_governorate: "beirut" }));
    fireEvent.click(screen.getByRole("button", { name: "Near me" }));
    await waitFor(() => expect(slotsArgs().at(-1)).toMatchObject({ p_governorate: null, p_district: null }));
    await waitFor(() => expect(names()).toEqual(["Tripoli Club", "Beirut Club"]));   // Tripoli is nearer Batroun
    expect(JSON.parse(localStorage.getItem("cb_prefs")!).gov).toBe("beirut");       // kept, not cleared
    fireEvent.click(screen.getByRole("button", { name: "Near me" }));
    await waitFor(() => expect(slotsArgs().at(-1)).toMatchObject({ p_governorate: "beirut" }));
    expect(screen.queryByText(/straight-line/)).toBeNull();
  });
  it("resumed on load with an area remembered: still not narrowed", async () => {
    localStorage.setItem("cb_near", "1");
    mount();
    await waitFor(() => expect(names()).toEqual(["Tripoli Club", "Beirut Club"]));
    expect(slotsArgs().at(-1)).toMatchObject({ p_governorate: null });
  });
  it("an answer from the location prompt that arrives after Near me was turned off is dropped", async () => {
    let answer!: () => void;
    getCurrentPosition = vi.fn((ok: (p: unknown) => void) => { answer = () => ok({ coords: BATROUN }); });
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition }, configurable: true });
    mount();
    await screen.findByText("Tripoli Club");
    fireEvent.click(screen.getByRole("button", { name: "Near me" }));
    await waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Finding you…" })).toBeTruthy();
    // the player picks Beirut in the area picker while the browser is still asking
    fireEvent.click(screen.getByText("▾").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: "All Lebanon" }));
    answer();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole("button", { name: "Near me" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText(/straight-line/)).toBeNull();
  });
});
