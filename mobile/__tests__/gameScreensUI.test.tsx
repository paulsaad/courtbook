/**
 * M3 game screens (Find a game, Game): privacy and role-dependent rendering, status presentation,
 * court-cancelled handling, the no-court wording, filtering and navigation, and game writes staying
 * off. The screens render what the database returned; these tests pin what each viewer sees.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a), replace: jest.fn() }, Stack: { Screen: () => null }, usePathname: () => "/games", useLocalSearchParams: () => ({}) }));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
const mockSession = { current: { status: "signed-in", session: { user: { id: "me" } } } as unknown };
jest.mock("../lib/session", () => ({ useSession: () => mockSession.current }));

import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { GameDetailView, type DetailHandlers } from "../components/game/GameDetailView";
import { GameCard } from "../components/game/GameCard";
import { detailSections, SCREEN_FEATURES, type DetailOptions } from "../lib/gameScreens";
import { GAME_WRITES_AVAILABLE, JOIN_LATER_TEXT, MANAGE_LATER_TEXT } from "../lib/gameActions";
import { NO_COURT } from "../lib/gameFormat";
import FindAGame from "../app/games/index";
import type { GameDetail, OpenGameRow, ParticipantRow } from "../lib/gameTypes";

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const wrap = (ui: ReactNode) => <SafeAreaProvider initialMetrics={metrics}>{ui}</SafeAreaProvider>;
const NOW = new Date("2026-11-19T10:00:00Z");

const base: GameDetail = {
  match_id: "m1", club_id: "c1", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", club_timezone: "Asia/Beirut", town: "Batroun",
  sport: "padel", start_at: "2026-11-21T16:00:00Z", end_at: "2026-11-21T17:30:00Z",
  level_min: 4, level_max: 6, level_legacy: false, my_level: 5, players_needed: 3, joined: 1, pending: null,
  status: "open", closed_reason: null, court_lost: false, note: "Friendly doubles, bring balls", join_mode: "approval",
  organizer_id: null, organizer_name: "Rami", my_status: null, i_organize: false,
  has_court: true, booking_id: null, court_name: "Court 2", started: false, finished: false, hidden: false,
};
const g = (o: Partial<GameDetail>): GameDetail => ({ ...base, ...o });
const person = (id: string, name: string, status: "accepted" | "pending", org = false): ParticipantRow =>
  ({ profile_id: id, name, level: 5, level_legacy: null, is_organizer: org, status });
const PEOPLE = [person("o", "Rami", "accepted", true), person("me", "Adam", "accepted"), person("b", "Bana", "pending"), person("j", "Joe", "pending")];
const OFF: DetailOptions = { writes: false, chat: false, report: false, now: NOW };
const ON: DetailOptions = { writes: true, chat: true, report: false, now: NOW };

async function show(d: GameDetail, people: ParticipantRow[] = [], o: DetailOptions = OFF, handlers: DetailHandlers = {}) {
  await render(wrap(<GameDetailView sections={detailSections(d, people, o)} me="me" pendingCount={d.i_organize ? d.pending ?? 0 : null} handlers={handlers} />));
}
const names = ["Rami", "Adam", "Bana", "Joe"];
const visibleNames = () => names.filter((n) => screen.queryAllByText(n).length > 0);

describe("player privacy (names only where the database returns them)", () => {
  it("A — a non-member sees counts and the organiser's name, not the players", async () => {
    await show(g({}), []);
    expect(screen.queryByTestId("player-names")).toBeNull();
    expect(screen.getByTestId("privacy-note")).toBeTruthy();
    expect(visibleNames()).toEqual(["Rami"]); // the organiser card only
  });
  it("B — a pending requester sees no names either, and the request banner", async () => {
    await show(g({ my_status: "pending" }), []);
    expect(screen.queryByTestId("player-names")).toBeNull();
    expect(screen.getByText("Names show once you're in the game.")).toBeTruthy();
    expect(screen.getByTestId("banner-pending")).toBeTruthy();
  });
  it("even if a list were passed for a non-member, the screen does not show it", async () => {
    await show(g({}), PEOPLE);
    expect(screen.queryByTestId("player-names")).toBeNull();
    expect(screen.queryByText("Adam")).toBeNull();
  });
  it("C — an accepted player sees the players (not the requests) and is marked You", async () => {
    await show(g({ my_status: "accepted" }), PEOPLE);
    expect(screen.getByTestId("player-names")).toBeTruthy();
    expect(screen.getAllByText("Adam").length).toBe(1);
    expect(screen.queryByTestId("requests")).toBeNull();
    expect(screen.queryByText("Bana")).toBeNull();
    expect(screen.getByText("You")).toBeTruthy();
  });
  it("D — the organiser sees players and the requests", async () => {
    await show(g({ i_organize: true, pending: 2 }), PEOPLE);
    expect(screen.getByTestId("requests")).toBeTruthy();
    expect(screen.getByText("Requests (2)")).toBeTruthy();
    expect(screen.getByText("Bana")).toBeTruthy();
    expect(screen.getByText("2 requests waiting")).toBeTruthy();
  });
});

describe("game writes stay off (M3-H not applied)", () => {
  it("the switches are off", () => {
    expect(GAME_WRITES_AVAILABLE).toBe(false);
    expect(SCREEN_FEATURES.writes).toBe(false);
  });
  it("a non-member gets the joining sentence, not a button", async () => {
    await show(g({}));
    expect(screen.getByText(JOIN_LATER_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ask to join" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  });
  it("the organiser gets no Accept, Decline, Remove or Manage controls", async () => {
    await show(g({ i_organize: true, pending: 2 }), PEOPLE);
    for (const name of ["Accept", "Decline", "Manage game"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByText("Remove")).toBeNull();
    expect(screen.getByText(MANAGE_LATER_TEXT)).toBeTruthy();
  });
  it("no Withdraw or Leave while off", async () => {
    await show(g({ my_status: "pending" }));
    expect(screen.queryByText("Withdraw request")).toBeNull();
    await show(g({ my_status: "accepted" }), PEOPLE);
    expect(screen.queryByText("Leave game")).toBeNull();
  });
  it("once switched on (later, approved step) the same screen draws them without a redesign", async () => {
    const onDecide = jest.fn();
    await show(g({ i_organize: true, pending: 2 }), PEOPLE, ON, { onDecide, onRemove: jest.fn(), onSecondary: jest.fn(), onPrimary: jest.fn() });
    await fireEvent.press(screen.getAllByRole("button", { name: "Accept" })[0]);
    expect(onDecide).toHaveBeenCalledWith("b", true);
    expect(screen.getByRole("button", { name: "Remove Adam" })).toBeTruthy();
  });
});

describe("court booking cancelled (E, GR-9)", () => {
  const lost = g({ i_organize: true, pending: 0, status: "closed", closed_reason: "no_court", court_lost: true, has_court: false, court_name: null });
  it("explains that joining is paused and shows the no-court wording", async () => {
    await show(lost, [person("o", "Rami", "accepted", true)]);
    expect(screen.getByTestId("banner-court_lost")).toBeTruthy();
    expect(screen.getByText(/Joining is paused/)).toBeTruthy();
    expect(screen.getByTestId("game-status")).toHaveTextContent("Court cancelled");
    expect(screen.getByTestId("game-court")).toHaveTextContent(NO_COURT);
  });
  it("lists the organiser's three choices; while writes are off they are information, not buttons", async () => {
    await show(lost);
    for (const k of ["link", "without", "cancel"]) expect(screen.getByTestId(`choice-${k}`)).toBeTruthy();
    expect(screen.getByText("Link another existing booking")).toBeTruthy();
    expect(screen.getByText("Proceed without a CourtBook reservation")).toBeTruthy();
    expect(screen.getByText("Cancel this game")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link another existing booking" })).toBeNull();
    expect(screen.getByText(/Nothing books a new court/)).toBeTruthy();
  });
  it("with writes on, each choice is a button that names its choice", async () => {
    const onChoose = jest.fn();
    await show(lost, [], ON, { onChoose });
    await fireEvent.press(screen.getByRole("button", { name: "Proceed without a CourtBook reservation" }));
    expect(onChoose).toHaveBeenCalledWith("without");
  });
  it("a player (not the organiser) sees the pause but no choices", async () => {
    await show(g({ my_status: "accepted", status: "closed", closed_reason: "no_court", court_lost: true, has_court: false, court_name: null }), PEOPLE);
    expect(screen.getByTestId("banner-court_lost")).toBeTruthy();
    expect(screen.queryByTestId("resolve")).toBeNull();
  });
});

describe("status presentation (words, not colour)", () => {
  it.each([
    ["open", {}, "Open"],
    ["full", { status: "closed" as const, closed_reason: "full" as const, joined: 3 }, "Full"],
    ["private", { status: "closed" as const, closed_reason: "organizer" as const, my_status: "accepted" as const }, "Private"],
    ["playing", { started: true, my_status: "accepted" as const }, "Playing now"],
    ["played", { started: true, finished: true, my_status: "accepted" as const }, "Played"],
    ["cancelled", { status: "cancelled" as const, my_status: "accepted" as const }, "Cancelled"],
  ])("%s", async (_n, o, label) => {
    await show(g(o), PEOPLE);
    expect(screen.getByTestId("game-status")).toHaveTextContent(label);
  });
  it("a game with a court booked through CourtBook says so; one without says the exact P1 wording", async () => {
    await show(g({}));
    expect(screen.getByTestId("game-court")).toHaveTextContent("Court 2 · Booked through CourtBook");
    await show(g({ has_court: false, court_name: null }));
    expect(screen.getByTestId("game-court")).toHaveTextContent(NO_COURT);
  });
  it("the hero gives screen readers one sentence with the day, time and status", async () => {
    await show(g({}));
    expect(screen.getByTestId("game-hero").props.accessibilityLabel).toBe("Padel, Saturday 21 November, 18:00 to 19:30, Open, Batroun Padel & Tennis Club · Batroun, Court 2");
  });
});

const row: OpenGameRow = {
  match_id: "g1", club_id: "c1", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", town: "Batroun", sport: "padel",
  start_at: "2026-11-21T16:00:00Z", end_at: "2026-11-21T17:30:00Z", level_min: 4, level_max: 6, level_legacy: false, my_level: 5,
  players_needed: 3, joined: 1, note: "Friendly doubles", organizer_name: "Rami", join_mode: "approval", i_joined: false, booking_id: "b1", court_name: "Court 2",
};

describe("Find a game card", () => {
  it("is one button that opens the game; the join mode is a label, not an action", async () => {
    const onPress = jest.fn();
    await render(wrap(<GameCard row={row} onPress={onPress} now={NOW} />));
    const card = screen.getByTestId("game-card-g1");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(card.props.accessibilityLabel).toMatch(/^Padel, Saturday 21 November, 18:00 to 19:30, Batroun Padel & Tennis Club, Batroun, Court 2, Levels 4–6, You're Level 5 · fits/);
    expect(screen.getByText("Ask to join")).toBeTruthy();
    await fireEvent.press(card);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it("a game without a booking says “No court booked through CourtBook”, plainly", async () => {
    await render(wrap(<GameCard row={{ ...row, booking_id: null, court_name: null }} onPress={jest.fn()} now={NOW} />));
    expect(screen.getByTestId("no-court")).toHaveTextContent(NO_COURT);
  });
});

describe("Find a game board: filters ask the database, cards navigate", () => {
  const rpc = supabase.rpc as jest.Mock;
  beforeEach(() => { rpc.mockReset(); mockPush.mockReset(); mockSession.current = { status: "signed-in", session: { user: { id: "me" } } }; });
  const board = async () => {
    rpc.mockImplementation(async (fn: string) => ({ data: fn === "open_matches" ? [row] : fn === "my_levels" ? [{ sport: "padel", level: 5 }] : [], error: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    await render(wrap(<QueryClientProvider client={qc}><FindAGame /></QueryClientProvider>));
    await waitFor(() => expect(screen.getByTestId("game-card-g1")).toBeTruthy());
  };
  const lastBoardCall = () => rpc.mock.calls.filter((c) => c[0] === "open_matches").at(-1)![1];

  it("default: every sport, any time, no level filter, all of Lebanon", async () => {
    await board();
    expect(lastBoardCall()).toMatchObject({ p_sport: null, p_fit: null, p_governorate: null, p_district: null });
  });
  it("sport, time and My level change what is asked for", async () => {
    await board();
    await fireEvent.press(screen.getByRole("button", { name: "Padel" }));
    await waitFor(() => expect(lastBoardCall().p_sport).toBe("padel"));
    await fireEvent.press(screen.getByRole("tab", { name: "Today" }));
    await fireEvent.press(screen.getByRole("button", { name: "My level (5)" }));
    await waitFor(() => expect(lastBoardCall()).toMatchObject({ p_sport: "padel", p_fit: "mine" }));
    expect(screen.getByText("Filters · 3")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Clear filters" }));
    // back to the defaults: the first (cached) answer is shown again, nothing filtered
    await waitFor(() => expect(screen.queryByText(/^Filters ·/)).toBeNull());
    expect(screen.getByRole("button", { name: "All sports" }).props.accessibilityState).toMatchObject({ selected: true });
  });
  it("tapping a card opens that game", async () => {
    await board();
    await fireEvent.press(screen.getByTestId("game-card-g1"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/game/[id]", params: { id: "g1" } });
  });
  it("signed out: no game function is called; a sign-in prompt is shown", async () => {
    mockSession.current = { status: "signed-out" };
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    await render(wrap(<QueryClientProvider client={qc}><FindAGame /></QueryClientProvider>));
    expect(screen.getByText("Sign in to find a game")).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
});

import { asCardRow, clubGameLabel } from "../components/game/ClubGames";
import { Row } from "../app/(tabs)/bookings";
import type { ClubGameRow } from "../lib/gameTypes";

describe("Club → Games and Bookings → Games open the game", () => {
  const club: ClubGameRow = {
    match_id: "g2", club_id: "c1", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", sport: "padel",
    start_at: "2026-11-21T16:00:00Z", end_at: null, level_min: null, level_max: null, level_legacy: false, my_level: null,
    players_needed: 3, joined: 3, pending: 0, status: "closed", closed_reason: "full", note: null, join_mode: "open",
    organizer_id: "o", organizer_name: "Rami", my_status: null, i_organize: false, booking_id: null, court_name: null,
  };
  it("a club game card says the player's part or the game's state, in words", () => {
    expect(clubGameLabel({ ...club, i_organize: true })).toBe("Organiser");
    expect(clubGameLabel({ ...club, my_status: "accepted" })).toBe("Joined");
    expect(clubGameLabel({ ...club, my_status: "pending" })).toBe("Requested");
    expect(clubGameLabel(club)).toBe("Full");
    expect(clubGameLabel({ ...club, closed_reason: "no_court" })).toBe("Court cancelled");
    expect(clubGameLabel({ ...club, closed_reason: "organizer" })).toBe("Private");
    expect(clubGameLabel({ ...club, status: "open" })).toBeUndefined();
    expect(asCardRow({ ...club, my_status: "pending" }).i_joined).toBe(true);
  });
  it("a game in Bookings → Games opens the Game screen; a booking still opens the booking", async () => {
    mockPush.mockReset();
    const base = { start_at: "2026-11-21T16:00:00Z", end_at: null, club_name: "Batroun", club_slug: "b", timezone: "Asia/Beirut", title: "Padel", status: "confirmed", role: null };
    await render(<><Row r={{ ...base, kind: "match", id: "g9" }} /><Row r={{ ...base, kind: "booking", id: "b9" }} /></>);
    const [game, booking] = screen.getAllByRole("button");
    await fireEvent.press(game);
    await fireEvent.press(booking);
    expect(mockPush.mock.calls).toEqual([[{ pathname: "/game/[id]", params: { id: "g9" } }], [{ pathname: "/booking/[id]", params: { id: "b9" } }]]);
  });
});

import { ActivityRow } from "../app/activity";
import { badgeText, kindIcon, relativeTime, unreadCount } from "../lib/activity";

describe("Activity (read-only)", () => {
  const n = { id: "n1", kind: "join_request", match_id: "g1", body: "Adam wants to join your match", created_at: "2026-11-19T09:55:00Z", read_at: null };
  it("an unread row says so, shows its time, and opens the game", async () => {
    mockPush.mockReset();
    await render(<ActivityRow n={n} now={NOW} />);
    const row = screen.getByTestId("notice-n1");
    expect(row.props.accessibilityLabel).toBe("Unread. Adam wants to join your match, 5 min ago");
    await fireEvent.press(row);
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/game/[id]", params: { id: "g1" } });
  });
  it("a notice without a game is not a button", async () => {
    await render(<ActivityRow n={{ ...n, match_id: null, read_at: "2026-11-19T09:56:00Z" }} now={NOW} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("notice-n1").props.accessibilityLabel).toBe("Adam wants to join your match, 5 min ago");
  });
  it("badge, unread count, icons and times", () => {
    expect([badgeText(0), badgeText(7), badgeText(120)]).toEqual([null, "7", "99+"]);
    expect(unreadCount([n, { ...n, id: "n2", read_at: "x" }])).toBe(1);
    expect([kindIcon("match_message"), kindIcon("booking_unlinked"), kindIcon("something_new")]).toEqual(["chat", "court", "bell"]);
    expect(relativeTime("2026-11-19T09:59:40Z", NOW)).toBe("Just now");
    expect(relativeTime("2026-11-19T07:00:00Z", NOW)).toBe("3 h ago");
    expect(relativeTime("2026-11-18T12:00:00Z", NOW)).toBe("Yesterday");
    expect(relativeTime("2026-11-14T12:00:00Z", NOW)).toBe("Sat 14 Nov");
  });
});

import { E2E_BOARD, E2E_SCREENS, e2eClient, e2eDetail } from "../lib/e2eGames";
import { gameKeys } from "../lib/games";
import { DEFAULT_FILTERS } from "../lib/gameFilters";

describe("emulator screenshot route (test builds only)", () => {
  it("is on only in the emulator test build (EXPO_PUBLIC_E2E=1)", () => expect(E2E_SCREENS).toBe(process.env.EXPO_PUBLIC_E2E === "1"));
  it("holds the sample answers fresh, so the screens make no call", () => {
    const qc = e2eClient("board", "A", "me");
    expect(qc.getQueryData(gameKeys.board(DEFAULT_FILTERS))).toBe(E2E_BOARD);
    expect(qc.getQueryState(gameKeys.board(DEFAULT_FILTERS))!.dataUpdatedAt).toBeGreaterThan(Date.now());
  });
  it.each(["A", "B", "C", "D", "E", "playing", "played", "private", "full", "cancelled", "nocourt"])("state %s renders", async (st) => {
    const { d, people } = e2eDetail(st, "me");
    await render(wrap(<GameDetailView sections={detailSections(d, people, OFF)} me="me" pendingCount={d.i_organize ? d.pending ?? 0 : null} />));
    expect(screen.getByTestId("game-hero")).toBeTruthy();
  });
});

import { activityKey, markRead, type Notice } from "../lib/activity";
import Activity from "../app/activity";

describe("Activity marks notices read (mark_notifications_read, own rows)", () => {
  const rows: Notice[] = [
    { id: "n1", kind: "join_request", match_id: "g1", body: "Adam wants to join your match", created_at: "2026-11-19T09:55:00Z", read_at: null },
    { id: "n2", kind: "match_message", match_id: "g2", body: "Rami: see you", created_at: "2026-11-19T09:00:00Z", read_at: null },
    { id: "n3", kind: "player_left", match_id: "g1", body: "Joe left your match", created_at: "2026-11-18T09:00:00Z", read_at: "2026-11-18T10:00:00Z" },
  ];
  const rpc = supabase.rpc as jest.Mock;
  beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ data: null, error: null }); mockSession.current = { status: "signed-in", session: { user: { id: "me" } } }; });

  it("marks exactly the given ids and clears them in the cache (badges drop at once)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    qc.setQueryData(activityKey, rows);
    await markRead(qc, ["n1"]);
    expect(rpc).toHaveBeenCalledWith("mark_notifications_read", { p_ids: ["n1"] });
    expect(qc.getQueryData<Notice[]>(activityKey)!.map((r) => !!r.read_at)).toEqual([true, false, true]);
  });
  it("a refused call changes nothing", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
    qc.setQueryData(activityKey, rows);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await markRead(qc, ["n1"]);
    expect(qc.getQueryData<Notice[]>(activityKey)![0].read_at).toBeNull();
  });
  it("opening Activity marks the unread rows shown, once; they stay bold for this visit", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
    qc.setQueryData(activityKey, rows, { updatedAt: Date.now() + 86_400_000 });
    await render(wrap(<QueryClientProvider client={qc}><Activity /></QueryClientProvider>));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("mark_notifications_read", { p_ids: ["n1", "n2"] }));
    expect(rpc.mock.calls.filter((c) => c[0] === "mark_notifications_read")).toHaveLength(1);
    expect(screen.getByTestId("notice-n1").props.accessibilityLabel).toMatch(/^Unread\./);
    expect(screen.getByTestId("notice-n3").props.accessibilityLabel).not.toMatch(/^Unread\./);
  });
});
