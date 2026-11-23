/**
 * Galaxy A17 acceptance (23 Nov): after a game was cancelled, "Hide from my games" did nothing and the game stayed
 * under Bookings → Games → Past and cancelled. Cause: the Game screen drew the button, but its secondary-action
 * handler had no branch for "hide". These tests drive the real Game screen, then the action and the list refresh.
 */
const mockRun = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockCanGoBack = jest.fn(() => true);
let mockDetail: unknown = null;

jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: () => mockBack(), replace: (...a: unknown[]) => mockReplace(...a), canGoBack: () => mockCanGoBack() },
  Stack: { Screen: () => null }, useLocalSearchParams: () => ({ id: "m1" }),
}));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
jest.mock("../lib/activity", () => ({ useActivity: () => ({ data: [] }), useMarkRead: () => undefined }));
jest.mock("../lib/safety", () => ({ ...jest.requireActual("../lib/safety"), useBlockedPlayers: () => ({ data: [] }), blockedNotice: () => null }));
jest.mock("../lib/games", () => ({ ...jest.requireActual("../lib/games"), useGamePeople: () => ({ data: undefined }) }));
jest.mock("../lib/gameScreens", () => {
  const actual = jest.requireActual("../lib/gameScreens");
  return {
    ...actual,
    useGameScreen: () => {
      const features = { writes: true, chat: true, report: false };
      return {
        load: { kind: "ready" }, detail: mockDetail,
        sections: actual.detailSections(mockDetail, undefined, { ...features, now: new Date("2026-11-23T20:00:00Z") }),
        actions: { run: mockRun, busy: () => false }, features, safety: { available: false }, refetch: jest.fn(), refreshing: false,
      };
    },
  };
});

import type { ReactNode } from "react";
import { Alert, type AlertButton } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import GameScreen from "../app/game/[id]";
import { rpcFor, runGameAction, SECONDARY_STEPS } from "../lib/gameActions";
import { gameKeys } from "../lib/games";
import type { Secondary } from "../lib/gameState";
import type { GameDetail } from "../lib/gameTypes";

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const wrap = (ui: ReactNode) => (
  <SafeAreaProvider initialMetrics={metrics}><QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider></SafeAreaProvider>
);
const cancelled: GameDetail = {
  match_id: "m1", club_id: "c1", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", club_timezone: "Asia/Beirut", town: "Batroun",
  sport: "padel", start_at: "2026-11-25T16:00:00Z", end_at: "2026-11-25T17:30:00Z",
  level_min: 4, level_max: 6, level_legacy: false, my_level: 5, players_needed: 3, joined: 1, pending: 0,
  status: "cancelled", closed_reason: null, court_lost: false, note: null, join_mode: "approval",
  organizer_id: "me", organizer_name: "Emma", my_status: "accepted", i_organize: true,
  has_court: true, booking_id: null, court_name: "Court 2", started: false, finished: false, hidden: false,
};

let answer = "Hide";
beforeEach(() => {
  mockRun.mockReset(); mockBack.mockReset(); mockReplace.mockReset(); mockCanGoBack.mockReset(); mockCanGoBack.mockReturnValue(true);
  answer = "Hide";
  jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons?: AlertButton[]) => { buttons?.find((b) => b.text === answer)?.onPress?.(); });
});
afterEach(() => jest.restoreAllMocks());

describe.each([
  ["the organiser who cancelled it", { i_organize: true, organizer_id: "me", my_status: "accepted" as const }],
  ["an accepted player", { i_organize: false, organizer_id: null, my_status: "accepted" as const }],
])("a cancelled game, for %s: Hide from my games", (_who, role) => {
  beforeEach(() => { mockDetail = { ...cancelled, ...role }; });

  it("asks once, hides it (hide_match), and leaves the game's screen", async () => {
    mockRun.mockResolvedValue({ kind: "done" });
    await render(wrap(<GameScreen />));
    await fireEvent.press(await screen.findByText("Hide from my games"));
    expect(Alert.alert).toHaveBeenCalledWith("Hide this game?", expect.stringMatching(/for you only/), expect.any(Array), expect.anything());
    await waitFor(() => expect(mockRun).toHaveBeenCalledWith({ kind: "hide", hidden: true }));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it("“Not now” hides nothing", async () => {
    answer = "Not now";
    await render(wrap(<GameScreen />));
    await fireEvent.press(await screen.findByText("Hide from my games"));
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("a refusal is shown and the screen stays", async () => {
    mockRun.mockResolvedValue({ kind: "refused", failure: { kind: "refused", message: "That game hasn't finished yet." } });
    await render(wrap(<GameScreen />));
    await fireEvent.press(await screen.findByText("Hide from my games"));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith("Not done", "That game hasn't finished yet."));
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("opened from a link (nothing to go back to): goes to Bookings", async () => {
    mockRun.mockResolvedValue({ kind: "done" });
    mockCanGoBack.mockReturnValue(false);
    await render(wrap(<GameScreen />));
    await fireEvent.press(await screen.findByText("Hide from my games"));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/bookings"));
  });
});

describe("every secondary button has an action (the class of bug, not just this one)", () => {
  const drawn: Secondary[] = ["withdraw", "leave", "manage", "hide"];
  it.each(drawn)("%s is handled", (s) => expect(SECONDARY_STEPS[s].kind).not.toBe("none"));

  it("hide runs hide_match(p_match, p_hidden = true) and leaves the screen; withdraw and leave are unchanged", () => {
    const hide = SECONDARY_STEPS.hide;
    if (hide.kind !== "confirm") throw new Error("hide must confirm and run");
    expect(rpcFor("m1", hide.action)).toEqual({ fn: "hide_match", args: { p_match: "m1", p_hidden: true } });
    expect(hide.leaveScreen).toBe(true);
    for (const s of ["withdraw", "leave"] as const) {
      const st = SECONDARY_STEPS[s];
      expect(st.kind === "confirm" && st.action).toEqual({ kind: "leave" });
      expect(st.kind === "confirm" && st.leaveScreen).toBe(false);
    }
  });
});

describe("after hiding, Bookings → Games is re-read (my_agenda excludes hidden games, 0042)", () => {
  it("a successful hide calls hide_match once and refreshes the agenda, the game and the boards", async () => {
    const qc = new QueryClient();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    const rpc = jest.fn(async () => ({ data: null, error: null }));
    const out = await runGameAction(qc, "m1", { kind: "hide", hidden: true }, { available: true, rpc: rpc as never });
    expect(out).toEqual({ kind: "done" });
    expect(rpc).toHaveBeenCalledWith("hide_match", { p_match: "m1", p_hidden: true });
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toEqual(expect.arrayContaining([JSON.stringify(gameKeys.agenda), JSON.stringify(gameKeys.detail("m1"))]));
  });
});
