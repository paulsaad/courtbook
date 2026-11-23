/**
 * Repeat use in the app (0087/0088): the first-use question asked once, "Your clubs" on Home, the areas screen, the
 * Courts tab opening on the account's last area with saved-area chips, and Directions from the exact map point.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a), navigate: jest.fn(), replace: jest.fn() }, Stack: { Screen: () => null }, usePathname: () => "/", useLocalSearchParams: () => ({}), useFocusEffect: jest.fn() }));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-image", () => ({ Image: () => null }));
const mockSession = { current: { status: "signed-in", session: { user: { id: "me" } } } as unknown };
jest.mock("../lib/session", () => ({ useSession: () => mockSession.current }));

import type { ReactNode } from "react";
import { Alert } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { fetchPlaying, rememberArea } from "../lib/playing";
import { AreasQuestionCard, YourClubsRow } from "../components/HomeExtras";
import Areas from "../app/areas";
import Courts from "../app/(tabs)/courts";
import { mapsUrl } from "../lib/clubInfo";

const rpc = supabase.rpc as jest.Mock;
const from = supabase.from as jest.Mock;
const ok = (data: unknown) => ({ data, error: null });
const MISSING = { data: null, error: { code: "PGRST202", message: "Could not find the function public.my_playing_prefs" } };
let prefs: unknown;
let favs: Array<{ club_id: string; name: string; slug: string; town: string | null; cover_url: null }>;
const calls = () => rpc.mock.calls.map((c) => c[0]);

function wrap(children: ReactNode) {
  // gcTime Infinity schedules no clean-up timer (a mutation's default 5-minute timer would keep Jest from exiting)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  rpc.mockReset(); from.mockReset(); mockPush.mockReset();
  prefs = { asked: false, areas: [], last: null };
  favs = [];
  rpc.mockImplementation(async (fn: string, args?: Record<string, unknown>) => {
    if (fn === "my_playing_prefs") return ok(prefs);
    if (fn === "dismiss_areas_question") return ok(null);
    if (fn === "set_playing_areas") { const a = args!.p_areas as unknown[]; prefs = { asked: true, last: null, areas: a.map((x) => ({ ...(x as object), label: "Saved" })) }; return ok(prefs); }
    if (fn === "set_last_area") return ok(null);
    if (fn === "my_favourite_clubs") return ok(favs);
    if (fn === "club_day_slots") return ok([]);
    if (fn === "areas") return ok([{ code: "north", name_en: "North", name_ar: "", districts: [{ code: "batroun", name_en: "Batroun", name_ar: "" }] }, { code: "beirut", name_en: "Beirut", name_ar: "", districts: [] }]);
    return ok(null);
  });
  from.mockImplementation(() => ({ select: () => ({ eq: () => ({ order: async () => ok([{ id: "t-batroun", name_en: "Batroun" }, { id: "t-kfar", name_en: "Kfar Abida" }]) }), in: async () => ok([]) }) }));
});

describe("data layer", () => {
  it("before 0088 the server has no function: null, so the screens stay as before", async () => {
    rpc.mockResolvedValueOnce(MISSING);
    await expect(fetchPlaying()).resolves.toBeNull();
  });
  it("the last area is remembered as codes only (a town only with its district)", async () => {
    rememberArea({ governorate: "north", district: "batroun", town: "t1", label: "Batroun" });
    rememberArea({ governorate: "north", district: null, town: "t1" });
    rememberArea(null);
    expect(rpc.mock.calls.map((c) => c[1])).toEqual([
      { p_governorate: "north", p_district: "batroun", p_town: "t1" },
      { p_governorate: "north", p_district: null, p_town: null },
      { p_governorate: null, p_district: null, p_town: null },
    ]);
  });
  it("Directions route to the exact map point", () => {
    expect(mapsUrl({ lat: 34.2553, lng: "35.6586", location_url: null })).toBe("https://www.google.com/maps/dir/?api=1&destination=34.2553,35.6586");
  });
});

describe("Home: Where do you usually play?", () => {
  it("asked when the account has not answered; 'Not now' answers it for good", async () => {
    await render(wrap(<AreasQuestionCard userId="me" />));
    expect(await screen.findByText("Where do you usually play?")).toBeTruthy();
    fireEvent.press(screen.getByTestId("areas-question-dismiss"));
    await waitFor(() => expect(calls()).toContain("dismiss_areas_question"));
    await waitFor(() => expect(screen.queryByTestId("areas-question")).toBeNull());
  });
  it("not asked again once answered (on any device: it is on the account)", async () => {
    prefs = { asked: true, areas: [], last: null };
    await render(wrap(<AreasQuestionCard userId="me" />));
    await waitFor(() => expect(calls()).toContain("my_playing_prefs"));
    await act(async () => {});
    expect(screen.queryByTestId("areas-question")).toBeNull();
  });
  it("before 0088: nothing is asked", async () => {
    rpc.mockImplementation(async () => MISSING);
    await render(wrap(<AreasQuestionCard userId="me" />));
    await waitFor(() => expect(calls()).toContain("my_playing_prefs"));
    await act(async () => {});
    expect(screen.queryByTestId("areas-question")).toBeNull();
  });
  it("'Choose my areas' opens the areas screen", async () => {
    await render(wrap(<AreasQuestionCard userId="me" />));
    fireEvent.press(await screen.findByTestId("areas-question-choose"));
    expect(mockPush).toHaveBeenCalledWith("/areas");
  });
});

describe("Home: Your clubs", () => {
  it("lists favourites from every region, one tap to the club", async () => {
    favs = [{ club_id: "c1", name: "Batroun Padel", slug: "b", town: "Batroun", cover_url: null }, { club_id: "c2", name: "Beirut Tennis", slug: "t", town: "Hamra", cover_url: null }];
    await render(wrap(<YourClubsRow userId="me" />));
    expect(await screen.findByText("Batroun Padel")).toBeTruthy();
    expect(screen.getByText("Beirut Tennis")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Batroun Padel, Batroun" }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/club/[id]", params: { id: "c1", name: "Batroun Padel" } });
    expect(screen.getByRole("button", { name: "Remove Batroun Padel from favourites" })).toBeTruthy();
  });
  it("nothing when there are none, or before 0087", async () => {
    await render(wrap(<YourClubsRow userId="me" />));
    await waitFor(() => expect(calls()).toContain("my_favourite_clubs"));
    expect(screen.queryByTestId("your-clubs")).toBeNull();
  });
});

describe("Where I play (areas screen)", () => {
  it("adds a town-level area (governorate → district → town) and saves it on the account", async () => {
    await render(wrap(<Areas />));
    fireEvent.press(await screen.findByTestId("areas-add"));
    fireEvent.press(await screen.findByTestId("gov-north"));
    fireEvent.press(await screen.findByTestId("district-batroun"));
    fireEvent.press(await screen.findByTestId("town-t-batroun"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_playing_areas", { p_areas: [{ governorate: "north", district: "batroun", town: "t-batroun" }] }));
  });
  it("removes an area", async () => {
    prefs = { asked: true, last: null, areas: [{ governorate: "beirut", district: null, town: null, label: "Beirut" }, { governorate: "north", district: "batroun", town: null, label: "Batroun" }] };
    await render(wrap(<Areas />));
    fireEvent.press(await screen.findByRole("button", { name: "Remove Beirut" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_playing_areas", { p_areas: [{ governorate: "north", district: "batroun", town: null }] }));
  });
  it("a refusal is said plainly", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const base = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (fn: string, a?: Record<string, unknown>) => (fn === "set_playing_areas" ? { data: null, error: { message: "too_many_areas" } } : base(fn, a)));
    await render(wrap(<Areas />));
    fireEvent.press(await screen.findByTestId("areas-add"));
    fireEvent.press(await screen.findByTestId("gov-beirut"));
    fireEvent.press(await screen.findByTestId("all-beirut"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Not saved", "You can keep up to 10 areas."));
    alert.mockRestore();
  });
});

describe("Courts tab: last area and saved areas", () => {
  it("opens on the account's last area and asks the server for that district; a saved town narrows by name", async () => {
    prefs = { asked: true, areas: [{ governorate: "beirut", district: null, town: null, label: "Beirut" }, { governorate: "north", district: "batroun", town: "t-batroun", label: "Batroun" }],
      last: { governorate: "north", district: "batroun", town: null, label: "Batroun" } };
    await render(wrap(<Courts />));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("club_day_slots", expect.objectContaining({ p_district: "batroun", p_governorate: null })));
    fireEvent.press(await screen.findByText("Beirut"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("club_day_slots", expect.objectContaining({ p_governorate: "beirut", p_district: null })));
    expect(rpc).toHaveBeenCalledWith("set_last_area", { p_governorate: "beirut", p_district: null, p_town: null });
    fireEvent.press(screen.getByText("All Lebanon"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("set_last_area", { p_governorate: null, p_district: null, p_town: null }));
  });
  it("signed out: no area chips and no account calls", async () => {
    mockSession.current = { status: "signed-out" };
    await render(wrap(<Courts />));
    await waitFor(() => expect(calls()).toContain("club_day_slots"));
    expect(screen.queryByTestId("area-chips")).toBeNull();
    expect(calls()).not.toContain("my_playing_prefs");
    mockSession.current = { status: "signed-in", session: { user: { id: "me" } } };
  });
});
