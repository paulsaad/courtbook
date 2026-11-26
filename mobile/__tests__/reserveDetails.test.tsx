/**
 * Booking continuation (Paul, 26 Nov): before the first court booking the club screen asks for what is missing (name,
 * contact phone) and then reserves the very selection the player chose. A complete profile reserves straight away.
 * A profile that cannot be read never lets the booking through silently, and never sends the player to a blank form.
 * Also: a new selection starts at 1 h where the club allows it.
 * The reservation itself (useReservation) is mocked: its safety is tested in reservation.test.tsx and the database suites.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockSubmit = jest.fn(async (_sel: { courtId: string; start: string }) => ({ kind: "confirmed" }));
const mockPush = jest.fn();
const mockProfile = {
  data: { name: "Rana", phone: "+96170123456", sports: [] as string[] } as { name: string | null; phone: string | null; sports: string[] } | undefined,
  refetch: jest.fn(async () => ({ data: undefined as unknown })),
};
const day = (h: number, m = 0) => new Date(Date.UTC(2030, 0, 15, h, m)).toISOString();
let mockParams: Record<string, string> = { id: "c1", name: "Test Club", at: day(8) };

jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), replace: jest.fn(), back: jest.fn() },
  Stack: { Screen: () => null },
  // the real hook runs its callback on focus and again when the callback changes while focused
  useFocusEffect: (cb: () => void) => { const React = jest.requireActual("react"); React.useEffect(cb, [cb]); },
  useLocalSearchParams: () => mockParams,
}));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
jest.mock("../lib/online", () => ({ useOnline: () => true }));
jest.mock("../lib/myProfile", () => ({ ...jest.requireActual("../lib/myProfile"), useMyProfile: () => mockProfile }));
jest.mock("../lib/clubInfo", () => ({ useClubInfo: () => ({ data: undefined, isRefetching: false, refetch: jest.fn() }) }));
jest.mock("../lib/reservation", () => ({
  useReservation: () => ({ locked: false, pending: null, phase: "idle", problem: null, blockedBy: null, clearProblem: jest.fn(), submit: mockSubmit, check: jest.fn() }),
}));
jest.mock("../components/game/ClubGames", () => ({ ClubGames: () => null }));
const mockRules = { slot: 30, min: 30, max: 180, free: 240 };
jest.mock("../lib/queries", () => {
  const actual = jest.requireActual("../lib/queries");
  return {
    ...actual,
    useDaySlots: () => ({
      isPending: false, isError: false, isSuccess: true, isFetching: false, isRefetching: false, dataUpdatedAt: Date.now(), refetch: jest.fn(),
      data: [8, 9, 10].map((h) => ({
        club_id: "c1", club_name: "Test Club", slug: "test", town: null, district: null, price_from: 20, sports: ["padel"],
        slot_minutes: mockRules.slot, min_minutes: mockRules.min, max_minutes: mockRules.max, service_fee_usd: 0, hold_minutes: 10,
        cancel_cutoff_hours: 6, timezone: "Asia/Beirut", court_id: "k1", court_name: "Court 1", court_sport: "padel",
        start_at: day(h), free_minutes: h === 8 ? mockRules.free : 240, is_demo: false,
      })),
    }),
    useClubMode: () => ({ data: "at_desk", isPending: false, isSuccess: true }),
    useTilePrices: () => ({ data: undefined }),
    useQuote: () => ({ isSuccess: true, isError: false, data: 20 }),
  };
});

import Club, { arrivalMinutes, defaultMinutes } from "../app/club/[id]";

const show = () => render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Club /></SafeAreaProvider>,
);

beforeEach(() => {
  mockSubmit.mockClear(); mockPush.mockClear(); mockProfile.refetch.mockReset();
  mockProfile.data = { name: "Rana", phone: "+96170123456", sports: [] };
  mockParams = { id: "c1", name: "Test Club", at: day(8) };
  Object.assign(mockRules, { slot: 30, min: 30, max: 180, free: 240 });
});

describe("Reserve and the player's details", () => {
  it("complete profile: reserves straight away, never asks", async () => {
    await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ courtId: "k1", start: day(8) });
  });

  it("phone missing: opens 'Before you book' and does not reserve yet", async () => {
    mockProfile.data = { name: "Rana", phone: null, sports: [] };
    await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith({ pathname: "/my-details", params: { for: "booking" } }));
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("back with the details saved: the same selection is reserved, once", async () => {
    mockProfile.data = { name: null, phone: null, sports: [] };
    const r = await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    // the details screen saved and went back: the profile is complete now
    mockProfile.data = { name: "Rana", phone: "+96170123456", sports: [] };
    await r.rerender(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Club /></SafeAreaProvider>);
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ courtId: "k1", start: day(8) });
    await r.rerender(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Club /></SafeAreaProvider>);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });

  it("back without saving: nothing is reserved", async () => {
    mockProfile.data = { name: "Rana", phone: null, sports: [] };
    const r = await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));
    mockProfile.data = { name: "Rana", phone: null, sports: [] };
    await r.rerender(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Club /></SafeAreaProvider>);
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("details cannot be read (offline): says so on the panel; no booking, no blank form", async () => {
    mockProfile.data = undefined;
    mockProfile.refetch.mockResolvedValue({ data: undefined });
    await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    expect(await screen.findByText("Couldn't check your details. Check your connection and try again.")).toBeTruthy();
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("details not loaded yet but readable: read once, then reserve", async () => {
    mockProfile.data = undefined;
    mockProfile.refetch.mockResolvedValue({ data: { name: "Rana", phone: "+46701234567", sports: [] } });
    await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
  });
});

describe("the selection is frozen while the details are read (review of #70)", () => {
  function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

  it("the player picks another time while the details load: nothing is booked", async () => {
    mockProfile.data = undefined;
    const d = deferred<{ data: unknown }>();
    mockProfile.refetch.mockReturnValue(d.promise);
    await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));       // 10:00 (Beirut) selected, details loading
    await fireEvent.press(screen.getByText("12:00"));                   // the player changes the time meanwhile
    await act(async () => { d.resolve({ data: { name: "Rana", phone: "+96170123456", sports: [] } }); });
    await waitFor(() => expect(mockProfile.refetch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSubmit).not.toHaveBeenCalled();                          // neither 10:00 nor 12:00 is booked by the old tap
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("a second tap while the details load does not start a second check", async () => {
    mockProfile.data = undefined;
    const d = deferred<{ data: unknown }>();
    mockProfile.refetch.mockReturnValue(d.promise);
    await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await act(async () => { d.resolve({ data: { name: "Rana", phone: "+96170123456", sports: [] } }); });
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockProfile.refetch).toHaveBeenCalledTimes(1);
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ courtId: "k1", start: day(8) });
  });

  it("unchanged selection: the one tapped is booked", async () => {
    mockProfile.data = undefined;
    const d = deferred<{ data: unknown }>();
    mockProfile.refetch.mockReturnValue(d.promise);
    await show();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await act(async () => { d.resolve({ data: { name: "Rana", phone: "+96170123456", sports: [] } }); });
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ start: day(8), minutes: 60 });
  });
});

describe("arriving from a time on the Courts list (review of #70)", () => {
  it("1 h free at that start: opens on 1 h (the club's minimum is 30 min)", async () => {
    await show();                                                       // p.at = 10:00 Beirut, free 4 h
    expect(screen.getByText(/10:00.*11:00/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ start: day(8), minutes: 60 });
  });
  it("only 30 min free at that start: keeps the time and opens on 30 min", async () => {
    mockRules.free = 30;
    await show();
    expect(screen.getByText(/10:00.*10:30/)).toBeTruthy();
    expect(screen.queryByText(/is no longer free/)).toBeNull();
    await fireEvent.press(screen.getByTestId("reserve-button"));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({ start: day(8), minutes: 30 });
  });
  it("the rule", () => {
    const at = day(8);
    expect(arrivalMinutes([30, 60, 90], [{ start: at, freeCourts: [{}] }], at)).toBe(60);
    expect(arrivalMinutes([30, 60, 90], [{ start: at, freeCourts: [] }], at)).toBe(30);
    expect(arrivalMinutes([30, 60, 90], [{ start: day(9), freeCourts: [{}] }], at)).toBe(30);
    expect(arrivalMinutes([90, 120], [{ start: at, freeCourts: [{}] }], at)).toBe(90);
  });
});

describe("default length: 1 h wherever the club's rules allow it (Paul, 26 Nov)", () => {
  it("the rule", () => {
    expect(defaultMinutes([30, 60, 90, 120])).toBe(60);
    expect(defaultMinutes([60, 90])).toBe(60);
    expect(defaultMinutes([90, 120])).toBe(90);   // club minimum above 1 h: its shortest
    expect(defaultMinutes([])).toBeNull();
  });
  it("the club screen opens on 1 h (it used to open on 1 h 30)", async () => {
    mockParams = { id: "c1", name: "Test Club" };
    await show();
    // the length chips are radio-like chips; the selected one is the 1 h chip
    type Node = { props: { accessibilityState?: { selected?: boolean } }; parent: Node | null };
    let node: Node | null = screen.getByText("1 h") as unknown as Node;
    while (node && node.props.accessibilityState?.selected === undefined) node = node.parent;
    expect(node?.props.accessibilityState?.selected).toBe(true);
  });
});
