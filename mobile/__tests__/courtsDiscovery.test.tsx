/**
 * Courts discovery (Mission 3B): a visitor who refuses location still has areas to choose from; "Nearest first" is
 * only said when the list really is sorted by distance.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), navigate: jest.fn() }, Stack: { Screen: () => null }, usePathname: () => "/courts", useLocalSearchParams: () => ({}), useFocusEffect: jest.fn() }));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-image", () => ({ Image: () => null }));
const mockSession = { current: { status: "signed-out" } as { status: string; session?: { user: { id: string } } } };
jest.mock("../lib/session", () => ({ useSession: () => mockSession.current }));
const mockLoc = { perm: { status: "undetermined", canAskAgain: true } as { status: string; canAskAgain: boolean } };
jest.mock("expo-location", () => ({
  Accuracy: { Low: 2 },
  getForegroundPermissionsAsync: async () => mockLoc.perm,
  requestForegroundPermissionsAsync: async () => mockLoc.perm,
  getCurrentPositionAsync: async () => ({ coords: { latitude: 33.8886, longitude: 35.4955 } }),
  hasServicesEnabledAsync: async () => true,
}));
const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({ getItemAsync: async (k: string) => mockStore.get(k) ?? null, setItemAsync: async (k: string, v: string) => { mockStore.set(k, v); } }));

import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import Courts from "../app/(tabs)/courts";

const rpc = supabase.rpc as jest.Mock;
const from = supabase.from as jest.Mock;
const slot = (id: string, name: string) => ({ club_id: id, club_name: name, slug: id, town: null, district: null, price_from: null, sports: ["padel"], slot_minutes: 30, min_minutes: 60, max_minutes: 120,
  service_fee_usd: 1, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut", court_id: `${id}-c`, court_name: "Court 1", court_sport: "padel", start_at: "2099-11-24T16:00:00Z", free_minutes: 120, is_demo: false });
const GOVS = [{ code: "beirut", name_en: "Beirut", name_ar: "بيروت", districts: [] }, { code: "north", name_en: "North Lebanon", name_ar: "الشمال", districts: [] }];
const calls: [string, unknown][] = [];
let pointsFail = false;

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  calls.length = 0; mockStore.clear(); pointsFail = false;
  mockSession.current = { status: "signed-out" };
  mockLoc.perm = { status: "undetermined", canAskAgain: true };
  rpc.mockReset().mockImplementation(async (fn: string, args?: unknown) => {
    calls.push([fn, args]);
    if (fn === "club_day_slots") return { data: [slot("far", "Tripoli Club"), slot("near", "Beirut Club")], error: null };
    if (fn === "areas") return { data: GOVS, error: null };
    if (fn === "my_playing_prefs") return { data: { asked: true, areas: [], last: null }, error: null };
    if (fn === "my_favourite_clubs") return { data: [], error: null };
    return { data: null, error: null };
  });
  from.mockReset().mockImplementation(() => ({
    select: () => ({
      eq: async () => pointsFail ? { data: null, error: { message: "network" } } : { data: [{ id: "far", lat: 34.4367, lng: 35.8497 }, { id: "near", lat: 33.8938, lng: 35.5018 }], error: null },
      in: async () => ({ data: [], error: null }),
    }),
  }));
});

describe("Courts discovery", () => {
  it("a visitor can narrow by governorate without an account, and nothing is remembered", async () => {
    await render(wrap(<Courts />));
    await screen.findByTestId("visitor-area-chips");
    fireEvent.press(screen.getByText("North Lebanon"));
    await waitFor(() => expect(calls.some(([fn, a]) => fn === "club_day_slots" && (a as { p_governorate?: string }).p_governorate === "north")).toBe(true));
    expect(calls.some(([fn]) => fn === "remember_last_area" || fn === "set_last_area")).toBe(false);
    expect(mockStore.size).toBe(0);
  });
  it("a visitor who refuses location is pointed at chips that are on screen", async () => {
    mockLoc.perm = { status: "denied", canAskAgain: false };
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    fireEvent.press(screen.getByTestId("near-me"));
    await screen.findByTestId("near-note");
    expect(screen.getByTestId("visitor-area-chips")).toBeTruthy();
  });
  it("signed-in players see their own area chips, not the visitor list, and the area list is not fetched", async () => {
    mockSession.current = { status: "signed-in", session: { user: { id: "me" } } };
    await render(wrap(<Courts />));
    await screen.findByTestId("area-chips");
    await act(async () => {});
    expect(screen.queryByTestId("visitor-area-chips")).toBeNull();
    expect(calls.some(([fn]) => fn === "areas")).toBe(false);
  });
  it("if club locations fail to load, it never claims the list is nearest first, and offers a retry", async () => {
    mockLoc.perm = { status: "granted", canAskAgain: true };
    pointsFail = true;
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    fireEvent.press(screen.getByTestId("near-me"));
    await screen.findByTestId("points-error");
    expect(screen.queryByText(/Nearest first/)).toBeNull();
    pointsFail = false;
    fireEvent.press(screen.getByText("Try again"));
    await screen.findByText(/Nearest first/);
    expect(screen.queryByTestId("points-error")).toBeNull();
  });
});
