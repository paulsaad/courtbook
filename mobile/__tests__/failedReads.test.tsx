/**
 * Player QA, 26 Nov (local, pilot line): two screens turned a failed or empty read into a wrong statement.
 *  - Home: when the player's bookings could not be read, "Your next booking" said "No upcoming bookings."
 *    with "Find a court", although the player had a booking. It now says the read failed and offers Try again.
 *  - Club: a link to a club that is not (or no longer) on CourtBook showed an empty club with "Nothing free on
 *    this day". It now says the club isn't available and offers Find a court.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockState = {
  agenda: { isPending: false, isError: true, data: undefined as unknown, error: { message: "TypeError: Network request failed" } as unknown, refetch: jest.fn(), isRefetching: false },
  info: { data: undefined as unknown, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } as unknown, isError: true, isRefetching: false, refetch: jest.fn() },
};

jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
const mockNavigate = jest.fn();
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: (...a: unknown[]) => mockNavigate(...a) },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: "gone-club" }),
}));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", userId: "me", session: { user: { id: "me" } } }) }));
jest.mock("../lib/online", () => ({ useOnline: () => true }));
jest.mock("../lib/profile", () => ({ useProfileName: () => ({ data: "Rana Khoury" }), firstName: (n: string | null) => (n ? n.split(" ")[0] : null) }));
jest.mock("../lib/activity", () => ({ useActivity: () => ({ data: [] }), unreadCount: () => 0, badgeText: () => null }));
jest.mock("../components/HomeExtras", () => ({ AreasQuestionCard: () => null, YourClubsRow: () => null }));
jest.mock("../components/PendingReservation", () => ({ PendingReservationBanner: () => null }));
jest.mock("../lib/bookings", () => ({ ...jest.requireActual("../lib/bookings"), useAgenda: () => mockState.agenda }));
jest.mock("../lib/clubInfo", () => ({ useClubInfo: () => mockState.info }));
jest.mock("../lib/reservation", () => ({
  useReservation: () => ({ locked: false, pending: null, phase: "idle", problem: null, blockedBy: null, clearProblem: jest.fn(), submit: jest.fn(), check: jest.fn() }),
}));
jest.mock("../components/game/ClubGames", () => ({ ClubGames: () => null }));
jest.mock("../lib/queries", () => ({
  ...jest.requireActual("../lib/queries"),
  useDaySlots: () => ({ isPending: false, isError: false, isSuccess: true, isFetching: false, isRefetching: false, dataUpdatedAt: Date.now(), refetch: jest.fn(), data: [] }),
  useClubMode: () => ({ data: undefined, isPending: false, isSuccess: true }),
  useTilePrices: () => ({ data: undefined }),
  useQuote: () => ({ isSuccess: false, isError: false, data: undefined }),
}));

import Home from "../app/(tabs)/index";
import Club from "../app/club/[id]";

const wrap = (el: React.ReactElement) => render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>{el}</SafeAreaProvider>);

describe("Home: the player's bookings could not be read", () => {
  beforeEach(() => { mockState.agenda = { ...mockState.agenda, isPending: false, isError: true, data: undefined, refetch: jest.fn() }; });
  it("says so and offers Try again — never 'No upcoming bookings'", async () => {
    await wrap(<Home />);
    expect(screen.queryByText("No upcoming bookings.")).toBeNull();
    expect(screen.getByText("No connection")).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(mockState.agenda.refetch).toHaveBeenCalledTimes(1);
  });
  it("read fine and nothing booked: the empty state as before", async () => {
    mockState.agenda = { ...mockState.agenda, isError: false, data: [], error: null };
    await wrap(<Home />);
    expect(screen.getByText("No upcoming bookings.")).toBeTruthy();
    expect(screen.queryByText("Try again")).toBeNull();
  });
});

describe("Club: a link to a club that isn't on CourtBook", () => {
  beforeEach(() => { mockNavigate.mockClear(); });
  it("no such club: 'Club not available' and Find a court, not 'Nothing free on this day'", async () => {
    mockState.info = { ...mockState.info, error: { code: "PGRST116", message: "no rows" }, isError: true };
    await wrap(<Club />);
    expect(screen.queryByText("Nothing free on this day")).toBeNull();
    expect(screen.getByText("Club not available")).toBeTruthy();
    fireEvent.press(screen.getByText("Find a court"));
    expect(mockNavigate).toHaveBeenCalledWith("/courts");
  });
  it("a club that exists with nothing free that day: unchanged", async () => {
    mockState.info = { ...mockState.info, data: { club: { id: "gone-club", name: "Test Club" } }, error: null, isError: false };
    await wrap(<Club />);
    expect(screen.getByText("Nothing free on this day")).toBeTruthy();
    expect(screen.queryByText("Club not available")).toBeNull();
  });
});
