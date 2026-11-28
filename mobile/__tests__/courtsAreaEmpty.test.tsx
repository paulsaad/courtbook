/**
 * Staging, 28 Nov (Galaxy A17, 0.4.0): free courts "disappeared" — "No free courts", checked just now, no error.
 * Cause reproduced here with the server's real behaviour: the demo club has no town, so club_day_slots returns
 * nothing for any area (North, Batroun …) and everything for all of Lebanon. The Courts tab opens on the account's
 * last area, so once North had been chosen, every day said "No free courts" after a restart.
 * Fixed: an empty area result names the area and offers all of Lebanon in one tap; a remembered area also updates
 * this device's copy at once, so the tab never reopens on an older area.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn() }, Stack: { Screen: () => null }, usePathname: () => "/courts", useLocalSearchParams: () => ({}), useFocusEffect: jest.fn() }));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));

import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import Courts from "../app/(tabs)/courts";

const rpc = supabase.rpc as jest.Mock;
const from = supabase.from as jest.Mock;
const ok = (data: unknown) => ({ data, error: null });
const NORTH = { governorate: "north", district: null, town: null, label: "North" };
let prefs: { asked: boolean; areas: unknown[]; last: unknown };
let serverLast: unknown;
// the demo club as staging has it: no town, so no district or governorate either
const slot = (start: string) => ({ club_id: "batroun", club_name: "Batroun Padel & Tennis Club", slug: "batroun", town: null, district: null, price_from: 20,
  sports: ["padel"], slot_minutes: 30, min_minutes: 60, max_minutes: 180, service_fee_usd: 1, hold_minutes: 10, cancel_cutoff_hours: 6,
  timezone: "Asia/Beirut", court_id: "p1", court_name: "Padel 1", court_sport: "padel", start_at: start, free_minutes: 180, is_demo: true });

function client() { return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } }); }
const wrap = (qc: QueryClient, children: ReactNode) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

beforeEach(() => {
  rpc.mockReset(); from.mockReset();
  prefs = { asked: true, areas: [NORTH], last: NORTH };
  serverLast = NORTH;
  rpc.mockImplementation(async (fn: string, a?: Record<string, unknown>) => {
    if (fn === "my_playing_prefs") return ok({ ...prefs, last: serverLast });
    if (fn === "set_last_area") { serverLast = a!.p_governorate ? { governorate: a!.p_governorate, district: a!.p_district, town: null, label: "North" } : null; return ok(null); }
    if (fn === "club_day_slots") return ok(a!.p_governorate || a!.p_district ? [] : [slot("2099-11-29T06:00:00Z"), slot("2099-11-29T06:30:00Z")]);
    if (fn === "my_favourite_clubs") return ok([]);
    return ok(null);
  });
  from.mockImplementation(() => ({ select: () => ({ eq: async () => ok([]), in: async () => ok([]) }) }));
});

describe("Courts: an area that finds nothing is not 'no free courts'", () => {
  it("opens on the last area (North): says where it looked and offers all of Lebanon, which shows the club", async () => {
    await render(wrap(client(), <Courts />));
    expect(await screen.findByText("No free courts in North")).toBeTruthy();
    expect(screen.getByText("Nothing free in North that day")).toBeTruthy();
    fireEvent.press(screen.getByText("Show all Lebanon"));
    expect(await screen.findByText("Batroun Padel & Tennis Club")).toBeTruthy();
    expect(screen.getByText("1 club with free times")).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith("set_last_area", { p_governorate: null, p_district: null, p_town: null });
  });

  it("without an area, an empty day still says plainly that nothing is free", async () => {
    prefs.last = null; serverLast = null;
    rpc.mockImplementation(async (fn: string) => ok(fn === "my_playing_prefs" ? { ...prefs, last: null } : fn === "my_favourite_clubs" ? [] : fn === "club_day_slots" ? [] : null));
    await render(wrap(client(), <Courts />));
    expect(await screen.findByText("Nothing free that day")).toBeTruthy();
    expect(screen.queryByText("Show all Lebanon")).toBeNull();
  });

  it("reopening the tab (same app session) opens on the area chosen last, not an older one", async () => {
    const qc = client();
    await render(wrap(qc, <Courts key="first" />));
    expect(await screen.findByText("No free courts in North")).toBeTruthy();
    fireEvent.press(screen.getByText("All Lebanon"));
    expect(await screen.findByText("Batroun Padel & Tennis Club")).toBeTruthy();
    // the prefs on this device are still fresh (5 minutes), so they are not re-read: the device copy must be current
    const prefsReads = rpc.mock.calls.filter((c) => c[0] === "my_playing_prefs").length;
    await screen.rerender(wrap(qc, <Courts key="again" />));   // a new Courts screen: its state starts over
    expect(await screen.findByText("Batroun Padel & Tennis Club")).toBeTruthy();
    expect(screen.queryByText("No free courts in North")).toBeNull();
    expect(rpc.mock.calls.filter((c) => c[0] === "my_playing_prefs").length).toBe(prefsReads);
  });

  it("a failed request is an error with Try again, never 'No free courts'", async () => {
    prefs.last = null; serverLast = null;
    rpc.mockImplementation(async (fn: string) => fn === "club_day_slots" ? { data: null, error: { code: "XX000", message: "upstream timeout" } }
      : ok(fn === "my_playing_prefs" ? { ...prefs, last: null } : fn === "my_favourite_clubs" ? [] : null));
    await render(wrap(client(), <Courts />));
    expect(await screen.findByText(/^(No connection|Couldn't load this)$/, undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.queryByText(/No free courts|Nothing free/)).toBeNull();
  });
});
