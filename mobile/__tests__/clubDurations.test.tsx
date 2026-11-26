/**
 * PR-9a: the club screen's "Play for" row offers every length the club allows. It used to show only the first four,
 * so at the usual 1 h to 3 h club, 3 h could not be booked in the app (the website offered it).
 */
import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  Stack: { Screen: () => null },
  useFocusEffect: () => {},
  useLocalSearchParams: () => ({ id: "c1", name: "Test Club" }),
}));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", userId: "me", session: { user: { id: "me" } } }) }));
jest.mock("../lib/online", () => ({ useOnline: () => true }));
jest.mock("../lib/myProfile", () => ({ useMyProfile: () => ({ data: { name: "Rana", phone: "+96170123456", sports: [] }, refetch: jest.fn() }), missingForBooking: () => [] }));
jest.mock("../lib/clubInfo", () => ({ useClubInfo: () => ({ data: undefined, isRefetching: false, refetch: jest.fn() }) }));
jest.mock("../lib/reservation", () => ({
  useReservation: () => ({ locked: false, pending: null, phase: "idle", problem: null, blockedBy: null, clearProblem: jest.fn(), submit: jest.fn(), check: jest.fn() }),
}));
jest.mock("../components/game/ClubGames", () => ({ ClubGames: () => null }));

const mockRules = { slot: 30, min: 60, max: 180 };
jest.mock("../lib/queries", () => {
  const actual = jest.requireActual("../lib/queries");
  const day = (h: number) => new Date(Date.UTC(2030, 0, 15, h, 0)).toISOString();
  return {
    ...actual,
    useDaySlots: () => ({
      isPending: false, isError: false, isSuccess: true, isFetching: false, isRefetching: false, dataUpdatedAt: Date.now(), refetch: jest.fn(),
      data: [8, 9, 10].map((h) => ({
        club_id: "c1", club_name: "Test Club", slug: "test", town: null, district: null, price_from: 20, sports: ["padel"],
        slot_minutes: mockRules.slot, min_minutes: mockRules.min, max_minutes: mockRules.max, service_fee_usd: 0, hold_minutes: 10,
        cancel_cutoff_hours: 6, timezone: "Asia/Beirut", court_id: "k1", court_name: "Court 1", court_sport: "padel",
        start_at: day(h), free_minutes: 240, is_demo: false,
      })),
    }),
    useClubMode: () => ({ data: "at_desk", isPending: false, isSuccess: true }),
    useTilePrices: () => ({ data: undefined }),
    useQuote: () => ({ isSuccess: false, isError: false, data: undefined }),
  };
});

import Club from "../app/club/[id]";

async function lengths(): Promise<string[]> {
  await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Club /></SafeAreaProvider>);
  // the chips' own text (nothing else on the screen is just a length: no time is selected, so no booking panel)
  return screen.queryAllByText(/^(\d+ h( \d+)?|\d+ min)$/).map((t) => [t.props.children].flat().join(""));
}

describe("club screen: every allowed booking length (PR-9a)", () => {
  it("1 h to 3 h on a 30-min grid: five chips, 3 h included", async () => {
    Object.assign(mockRules, { slot: 30, min: 60, max: 180 });
    expect(await lengths()).toEqual(["1 h", "1 h 30", "2 h", "2 h 30", "3 h"]);
  });
  it("30 min to 4 h: all eight", async () => {
    Object.assign(mockRules, { slot: 30, min: 30, max: 240 });
    expect(await lengths()).toEqual(["30 min", "1 h", "1 h 30", "2 h", "2 h 30", "3 h", "3 h 30", "4 h"]);
  });
  it("minimum equal to maximum: one chip", async () => {
    Object.assign(mockRules, { slot: 30, min: 90, max: 90 });
    expect(await lengths()).toEqual(["1 h 30"]);
  });
});
