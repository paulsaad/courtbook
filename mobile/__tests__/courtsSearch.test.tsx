/**
 * Courts search in the app (Paul, 26 Nov): "Club or town", as on the website's Courts page — the same function
 * (club_day_slots) with the same p_query, combined with the sport, area and day filters. Cleared in one tap.
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
    if (fn === "club_day_slots") {
      const q = (args as { p_query?: string | null })?.p_query;
      const all = [slot("far", "Tripoli Club"), slot("near", "Beirut Club")];
      return { data: q ? all.filter((r) => r.club_name.toLowerCase().includes(q.toLowerCase())) : all, error: null };
    }
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


const queries = () => calls.filter(([fn]) => fn === "club_day_slots").map(([, a]) => (a as { p_query: string | null }).p_query);

describe("Courts search", () => {
  it("searches on the keyboard's Search key, through club_day_slots' p_query (as the website)", async () => {
    await render(wrap(<Courts />));
    expect(await screen.findByText("Tripoli Club")).toBeTruthy();
    expect(queries()).toEqual([null]);
    await fireEvent.changeText(screen.getByTestId("courts-search-input"), "  beirut ");
    expect(queries()).toEqual([null]);                     // typing alone does not search
    await fireEvent(screen.getByTestId("courts-search-input"), "submitEditing");
    await waitFor(() => expect(queries()).toEqual([null, "beirut"]));
    await waitFor(() => expect(screen.queryByText("Tripoli Club")).toBeNull());
    expect(screen.getByText("Beirut Club")).toBeTruthy();
    expect(screen.getByTestId("courts-search-note").props.children.join("")).toBe("Showing clubs matching “beirut”");
  });

  it("the search keeps the sport filter (one request carries both)", async () => {
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    await fireEvent.press(screen.getByText("Padel"));
    await fireEvent.changeText(screen.getByTestId("courts-search-input"), "tri");
    await fireEvent(screen.getByTestId("courts-search-input"), "submitEditing");
    await waitFor(() => expect(calls.some(([fn, a]) => fn === "club_day_slots" && (a as { p_sport: string }).p_sport === "padel" && (a as { p_query: string }).p_query === "tri")).toBe(true));
  });

  it("no match: says so with Clear search, which brings every club back", async () => {
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    await fireEvent.changeText(screen.getByTestId("courts-search-input"), "zahle");
    await fireEvent(screen.getByTestId("courts-search-input"), "submitEditing");
    expect(await screen.findByText("No free courts matching “zahle”")).toBeTruthy();
    await fireEvent.press(screen.getByText("Clear search"));
    expect(await screen.findByText("Tripoli Club")).toBeTruthy();
    expect(screen.queryByTestId("courts-search-note")).toBeNull();
  });

  it("the ✕ clears the box and the search", async () => {
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    await fireEvent.changeText(screen.getByTestId("courts-search-input"), "beirut");
    await fireEvent(screen.getByTestId("courts-search-input"), "submitEditing");
    await waitFor(() => expect(screen.queryByText("Tripoli Club")).toBeNull());
    await fireEvent.press(screen.getByTestId("courts-search-clear"));
    expect(await screen.findByText("Tripoli Club")).toBeTruthy();
    expect(screen.getByTestId("courts-search-input").props.value).toBe("");
  });
});
