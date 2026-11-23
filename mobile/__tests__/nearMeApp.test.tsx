/**
 * Near me in the app (repeat-use-location): never asks on its own; a tap asks once (approximate, foreground); the
 * position is never sent or stored; refusal falls back to areas; choosing an area turns it off.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), navigate: jest.fn() }, Stack: { Screen: () => null }, usePathname: () => "/courts", useLocalSearchParams: () => ({}), useFocusEffect: jest.fn() }));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
const mockLoc = {
  perm: { status: "undetermined", canAskAgain: true } as { status: string; canAskAgain: boolean },
  afterRequest: { status: "granted", canAskAgain: true } as { status: string; canAskAgain: boolean },
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(async () => true),
};
jest.mock("expo-location", () => ({
  Accuracy: { Low: 2 },
  getForegroundPermissionsAsync: (...a: unknown[]) => mockLoc.getForegroundPermissionsAsync(...a),
  requestForegroundPermissionsAsync: (...a: unknown[]) => mockLoc.requestForegroundPermissionsAsync(...a),
  getCurrentPositionAsync: (...a: unknown[]) => mockLoc.getCurrentPositionAsync(...a),
  hasServicesEnabledAsync: () => mockLoc.hasServicesEnabledAsync(),
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
const ME = { latitude: 33.8886, longitude: 35.4955 };   // Beirut
const slot = (id: string, name: string) => ({ club_id: id, club_name: name, slug: id, town: null, district: null, price_from: null, sports: ["padel"], slot_minutes: 30, min_minutes: 60, max_minutes: 120,
  service_fee_usd: 1, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut", court_id: `${id}-c`, court_name: "Court 1", court_sport: "padel", start_at: "2099-11-24T16:00:00Z", free_minutes: 120, is_demo: false });
const sent: unknown[] = [];

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  sent.length = 0; mockStore.clear();
  mockLoc.perm = { status: "undetermined", canAskAgain: true };
  mockLoc.afterRequest = { status: "granted", canAskAgain: true };
  mockLoc.getForegroundPermissionsAsync.mockReset().mockImplementation(async () => mockLoc.perm);
  mockLoc.requestForegroundPermissionsAsync.mockReset().mockImplementation(async () => { mockLoc.perm = mockLoc.afterRequest; return mockLoc.afterRequest; });
  mockLoc.getCurrentPositionAsync.mockReset().mockImplementation(async () => ({ coords: ME }));
  rpc.mockReset().mockImplementation(async (fn: string, args?: unknown) => {
    sent.push([fn, args]);
    if (fn === "club_day_slots") return { data: [slot("far", "Tripoli Club"), slot("near", "Beirut Club")], error: null };
    if (fn === "my_playing_prefs") return { data: { asked: true, areas: [{ governorate: "north", district: null, town: null, label: "North" }], last: null }, error: null };
    if (fn === "my_favourite_clubs") return { data: [], error: null };
    return { data: null, error: null };
  });
  from.mockReset().mockImplementation((t: string) => ({
    select: (cols: string) => ({
      eq: async (c: string, v: unknown) => { sent.push(["from", t, cols, c, v]); return { data: [{ id: "far", lat: 34.4367, lng: 35.8497 }, { id: "near", lat: 33.8938, lng: 35.5018 }], error: null }; },
      in: async () => ({ data: [], error: null }),
    }),
  }));
});
const order = () => screen.getAllByRole("button").map((b) => b.props.accessibilityLabel as string).filter((l) => /Club/.test(l ?? "") && !/at |favourites/.test(l));

describe("Near me (app)", () => {
  it("never asks or reads a position on load", async () => {
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    await act(async () => {});
    expect(mockLoc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(mockLoc.getCurrentPositionAsync).not.toHaveBeenCalled();
  });
  it("a tap asks once, approximate; nearest first with distances; the position is never sent or stored", async () => {
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    fireEvent.press(screen.getByTestId("near-me"));
    await waitFor(() => expect(order()[0]).toMatch(/^Beirut Club, under 1 kilometre away/));
    expect(order()[1]).toMatch(/^Tripoli Club, 69 kilometres away/);
    expect(mockLoc.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockLoc.getCurrentPositionAsync).toHaveBeenCalledWith({ accuracy: 2 });
    expect(screen.getByText("Nearest first · straight-line distances")).toBeTruthy();
    expect(JSON.stringify(sent)).not.toMatch(/33\.88|35\.49|latitude/);
    expect([...mockStore.values()].join()).not.toMatch(/33\.8|35\.4/);
    expect(JSON.parse([...mockStore.values()][0])).toEqual({ useLocation: true, governorate: null, district: null });
  });
  it("refused: says so, keeps areas, remembers nothing", async () => {
    mockLoc.afterRequest = { status: "denied", canAskAgain: true };
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    fireEvent.press(screen.getByTestId("near-me"));
    expect((await screen.findByTestId("near-note")).props.children).toMatch(/Location is off\. Choose an area instead/);
    expect(mockLoc.getCurrentPositionAsync).not.toHaveBeenCalled();
    expect(JSON.parse([...mockStore.values()][0]).useLocation).toBe(false);
  });
  it("blocked in Settings: no prompt is attempted; the note says where to change it", async () => {
    mockLoc.perm = { status: "denied", canAskAgain: false };
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    fireEvent.press(screen.getByTestId("near-me"));
    expect((await screen.findByTestId("near-note")).props.children).toMatch(/phone's Settings/);
    expect(mockLoc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
  it("chosen before and still allowed: resumes on load without asking", async () => {
    mockStore.set("discovery_prefs_v1", JSON.stringify({ useLocation: true, governorate: null, district: null }));
    mockLoc.perm = { status: "granted", canAskAgain: true };
    await render(wrap(<Courts />));
    await waitFor(() => expect(order()[0]).toMatch(/^Beirut Club, under 1 kilometre/));
    expect(mockLoc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
  it("choosing a saved area turns Near me off (an area wins)", async () => {
    await render(wrap(<Courts />));
    await screen.findByText("Tripoli Club");
    fireEvent.press(screen.getByTestId("near-me"));
    await waitFor(() => expect(screen.getByText("Nearest first · straight-line distances")).toBeTruthy());
    fireEvent.press(await screen.findByText("North"));
    await waitFor(() => expect(screen.queryByText("Nearest first · straight-line distances")).toBeNull());
    expect(JSON.parse([...mockStore.values()][0]).useLocation).toBe(false);
  });
});
