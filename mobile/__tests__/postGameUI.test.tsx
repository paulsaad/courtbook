/**
 * Post a game and Edit game screens: the joining choice is clear and sent as chosen, a booking posts
 * as a booking, a double tap posts once, a refusal is shown, and Edit keeps to what update_match allows.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { getUser: jest.fn(), onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockParams = { current: {} as Record<string, string> };
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: (...a: unknown[]) => mockReplace(...a), back: () => mockBack() }, Stack: { Screen: () => null }, useLocalSearchParams: () => mockParams.current }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
jest.mock("../lib/online", () => ({ useOnline: () => true }));
jest.mock("../lib/gameActions", () => ({ ...jest.requireActual("../lib/gameActions"), GAME_WRITES_AVAILABLE: true }));
jest.mock("../lib/postGame", () => ({ ...jest.requireActual("../lib/postGame"), usePostGame: jest.fn(), POST_TOKEN_AVAILABLE: true }));

import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import * as postGameLib from "../lib/postGame";
import PostGame from "../app/games/post";
import EditGame from "../app/games/edit";
import { bookingDays } from "../lib/days";
import { gameKeys } from "../lib/games";
import type { GameDetail } from "../lib/gameTypes";

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const CLUBS = [
  { id: "c1", name: "Batroun Padel & Tennis Club", town: "Batroun", timezone: "Asia/Beirut", openTime: "08:00:00", closeTime: "23:00:00", slotMinutes: 30, sports: ["padel", "tennis"] },
];
const BOOKINGS = [
  { id: "b1", clubId: "c1", clubName: "Batroun Padel & Tennis Club", timezone: "Asia/Beirut", courtName: "Padel 2", sport: "padel", startAt: "2030-01-05T16:00:00Z", endAt: "2030-01-05T17:30:00Z", gameId: null },
];

function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, staleTime: Infinity, retry: false } } });
  const far = Date.now() + 864e5;
  qc.setQueryData(["post-clubs"], CLUBS, { updatedAt: far });
  qc.setQueryData(["post-bookings"], BOOKINGS, { updatedAt: far });
  return qc;
}
const show = async (ui: ReactNode, qc = client()) =>
  await render(<SafeAreaProvider initialMetrics={metrics}><QueryClientProvider client={qc}>{ui}</QueryClientProvider></SafeAreaProvider>);

/** usePostGame backed by a fake post_match: real postGame (single flight, outcomes), fake RPC. */
function fakePost(rpc: jest.Mock, lookup: () => Promise<string | null> = async () => null) {
  const real = jest.requireActual("../lib/postGame") as typeof postGameLib;
  (postGameLib.usePostGame as jest.Mock).mockImplementation(() => {
    const qc = new QueryClient();
    return {
      post: (args: Parameters<typeof real.postGame>[1]) => real.postGame(qc, args, { available: true, rpc, lookup }),
      check: jest.fn(async () => ({ kind: "none" })),
      busy: false,
    };
  });
}

beforeEach(() => { jest.clearAllMocks(); mockParams.current = {}; });

async function chooseTime() {
  await fireEvent.press(screen.getByText("Padel"));
  await fireEvent.press(screen.getByTestId("club-c1"));
  const tomorrow = bookingDays("Asia/Beirut", 2)[1];
  await fireEvent.press(screen.getByLabelText(tomorrow.a11y));
  await fireEvent.press(screen.getByText("18:00"));
}

describe("Post a game", () => {
  it("the joining choice is shown with what each means; Join straight away by default", async () => {
    fakePost(jest.fn());
    await show(<PostGame />);
    expect(screen.getByText("Join straight away")).toBeTruthy();
    expect(screen.getByText("Ask to join")).toBeTruthy();
    expect(screen.getByTestId("join-mode-text").props.children).toBe("Players join straight away, while there are places.");
    await fireEvent.press(screen.getByText("Ask to join"));
    expect(screen.getByTestId("join-mode-text").props.children).toBe("Players ask to join. You accept or decline each request.");
  });

  it.each([["Join straight away", "open"], ["Ask to join", "approval"]] as const)("posts with %s and opens the new game", async (label, mode) => {
    const rpc = jest.fn(async (..._a: unknown[]) => ({ data: "g-new", error: null }));
    fakePost(rpc);
    await show(<PostGame />);
    await fireEvent.press(screen.getByText("No booking — choose a time"));
    await chooseTime();
    await fireEvent.press(screen.getByText(label));
    expect(screen.getByTestId("post-review").props.children.join("")).toContain("Batroun Padel & Tennis Club");
    await fireEvent.press(screen.getByTestId("post-submit"));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith({ pathname: "/game/[id]", params: { id: "g-new" } }));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0] as unknown[])[1]).toMatchObject({ p_club: "c1", p_sport: "padel", p_booking: null, p_join_mode: mode, p_players_needed: 3 });
  });

  it("from a booking (Find players): posts the booking; club and time come from it", async () => {
    mockParams.current = { booking: "b1" };
    const rpc = jest.fn(async (..._a: unknown[]) => ({ data: "g-b", error: null }));
    fakePost(rpc);
    await show(<PostGame />);
    expect(screen.queryByText("Sport")).toBeNull();
    await fireEvent.press(screen.getByTestId("post-submit"));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect((rpc.mock.calls[0] as unknown[])[1]).toMatchObject({ p_booking: "b1", p_club: null, p_start: null, p_sport: "padel", p_players_needed: 1 });
  });

  it("a booking that already has a game: offers to open it, no form", async () => {
    mockParams.current = { booking: "b1" };
    fakePost(jest.fn());
    const qc = client();
    qc.setQueryData(["post-bookings"], [{ ...BOOKINGS[0], gameId: "g-old" }]);
    await show(<PostGame />, qc);
    expect(screen.getByText("You already posted a game for this booking")).toBeTruthy();
    expect(screen.queryByTestId("post-submit")).toBeNull();
  });

  it("two quick taps post once", async () => {
    let resolve!: (v: unknown) => void;
    const rpc = jest.fn(() => new Promise((r) => { resolve = r; }));
    fakePost(rpc);
    await show(<PostGame />);
    await fireEvent.press(screen.getByText("No booking — choose a time"));
    await chooseTime();
    await fireEvent.press(screen.getByTestId("post-submit"));
    await fireEvent.press(screen.getByTestId("post-submit")); // the first call is still waiting for its answer
    resolve({ data: "g1", error: null });
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("a refusal is shown and nothing opens", async () => {
    fakePost(jest.fn(async () => ({ data: null, error: { message: "too_many_games", code: "P0001" } })));
    await show(<PostGame />);
    await fireEvent.press(screen.getByText("No booking — choose a time"));
    await chooseTime();
    await fireEvent.press(screen.getByTestId("post-submit"));
    expect(await screen.findByText("You already have 10 open games. Close one to post another.")).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("with 0073: a lost answer the check can't settle offers Try again, which re-posts with the same key", async () => {
    const rpc = jest.fn()
      .mockImplementationOnce(async () => { throw new TypeError("Network request failed"); })
      .mockImplementationOnce(async () => ({ data: "g-1", error: null }));
    fakePost(rpc, async () => { throw new TypeError("Network request failed"); });
    await show(<PostGame />);
    await fireEvent.press(screen.getByText("No booking — choose a time"));
    await chooseTime();
    await fireEvent.press(screen.getByTestId("post-submit"));
    expect(await screen.findByText("We couldn't confirm whether your game was posted. Check again before posting.")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("post-retry"));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith({ pathname: "/game/[id]", params: { id: "g-1" } }));
    const keys = rpc.mock.calls.map((c) => (c[1] as { p_token?: string }).p_token);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("Post stays off until the time is chosen", async () => {
    fakePost(jest.fn());
    await show(<PostGame />);
    await fireEvent.press(screen.getByText("No booking — choose a time"));
    expect(screen.getByTestId("post-submit").props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByText("Choose a sport.")).toBeTruthy();
  });
});

const game: GameDetail = {
  match_id: "m1", club_id: "c1", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", club_timezone: "Asia/Beirut", town: "Batroun",
  sport: "padel", start_at: "2030-01-05T16:00:00Z", end_at: "2030-01-05T17:30:00Z", level_min: null, level_max: null, level_legacy: false, my_level: null,
  players_needed: 3, joined: 2, pending: 3, status: "open", closed_reason: null, court_lost: false, note: "Friendly", join_mode: "approval",
  organizer_id: "me", organizer_name: "Emma", my_status: null, i_organize: true, has_court: false, booking_id: null, court_name: null,
  started: false, finished: false, hidden: false,
};

describe("Edit game", () => {
  const withGame = (d: GameDetail) => { const qc = client(); qc.setQueryData(gameKeys.detail("m1"), d, { updatedAt: Date.now() + 864e5 }); return qc; };
  beforeEach(() => { mockParams.current = { id: "m1" }; });

  it("players needed cannot go below the players already in", async () => {
    await show(<EditGame />, withGame(game));
    expect(await screen.findByText("Not counting you. 2 already in, so at least 2.")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("players-minus", { includeHiddenElements: true })); // 3 → 2
    await fireEvent.press(screen.getByTestId("players-minus", { includeHiddenElements: true })); // stays 2
    expect(screen.getByTestId("players").props.accessibilityValue).toMatchObject({ now: 2, min: 2 });
  });

  it("switching to Join straight away says what happens to the waiting requests, then saves through update_match", async () => {
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: null });
    await show(<EditGame />, withGame(game));
    await fireEvent.press(await screen.findByText("Join straight away"));
    expect(screen.getByText("When you save, 1 waiting player is accepted in the order they asked. The others keep waiting for your answer.")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("edit-save"));
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    expect(supabase.rpc).toHaveBeenCalledWith("update_match", { p_match: "m1", p_players_needed: 3, p_level_min: null, p_level_max: null, p_note: "Friendly", p_join_mode: "open" });
  });

  it("Save stays off until something changes", async () => {
    await show(<EditGame />, withGame(game));
    expect((await screen.findByTestId("edit-save")).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("a cancelled or started game cannot be edited", async () => {
    await show(<EditGame />, withGame({ ...game, status: "cancelled" }));
    expect(await screen.findByText("This game was cancelled.")).toBeTruthy();
    expect(screen.queryByTestId("edit-save")).toBeNull();
  });

  it("a refusal (below_accepted) is shown; nothing closes", async () => {
    (supabase.rpc as jest.Mock).mockImplementation(async (fn: string) => fn === "update_match"
      ? { data: null, error: { message: "below_accepted", code: "P0001" } }
      : { data: [{ ...game, joined: 0 }], error: null }); // the re-read after the refusal
    await show(<EditGame />, withGame({ ...game, joined: 0 }));
    await fireEvent.press(await screen.findByTestId("players-minus", { includeHiddenElements: true }));
    await fireEvent.press(screen.getByTestId("edit-save"));
    expect(await screen.findByText("You already have more players accepted than that.")).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });
});
