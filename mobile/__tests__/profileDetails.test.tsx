/**
 * Profile (Paul, 26 Nov): the player's details can be seen and edited later; sports and levels are optional and set
 * from Profile (set_player_level, as on the website). Account deletion stays where it was.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockDb = { row: { name: "Rana Khoury", phone: "+96170123456", sports: ["padel", "tennis"] } as Record<string, unknown>, levels: [{ sport: "padel", level: 5 }], rpcError: null as unknown };
const mockRpc = jest.fn(async (fn: string, args?: { p_sport: string; p_level: number | null }) => {
  if (fn === "my_levels") return { data: mockDb.levels, error: null };
  if (fn === "set_player_level") {
    if (mockDb.rpcError) return { data: null, error: mockDb.rpcError };
    mockDb.levels = mockDb.levels.filter((l) => l.sport !== args!.p_sport).concat(args!.p_level == null ? [] : [{ sport: args!.p_sport, level: args!.p_level }]);
    return { data: null, error: null };
  }
  return { data: null, error: null };
});
jest.mock("../lib/supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => mockRpc(...(a as [string])),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...mockDb.row }, error: null }) }) }) }),
    auth: { signOut: jest.fn() },
  },
}));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
jest.mock("expo-updates", () => ({ channel: "production" }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me", email: "rana@example.test" } } }) }));
jest.mock("../lib/buildInfo", () => ({ currentBuild: () => [] }));
jest.mock("../lib/appIdentity", () => ({ installedVariant: "live" }));
jest.mock("../lib/activity", () => ({ useActivity: () => ({ data: [] }), unreadCount: () => 0, badgeText: () => null }));
jest.mock("../lib/safety", () => ({ useSafety: () => ({ available: false }) }));
jest.mock("../lib/testFaults", () => ({ FAULT_LABEL: {}, currentFault: () => "off", faultsAvailable: () => false, setFault: jest.fn(), subscribeFault: () => () => {} }));
jest.mock("../lib/crash", () => ({ E2E_PROBES: false, crashNatively: jest.fn(), sendPrivacyProbe: jest.fn(), sendTestReport: jest.fn() }));
jest.mock("../components/BlockedPlayers", () => ({ BlockedPlayers: () => null }));
jest.mock("../components/DeleteAccount", () => { const { Text } = jest.requireActual("react-native"); return { DeleteAccount: () => <Text>Delete my account</Text> }; });

import Profile from "../app/(tabs)/profile";

async function show(children: ReactNode = <Profile />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  return render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </SafeAreaProvider>,
  );
}
beforeEach(() => {
  mockDb.row = { name: "Rana Khoury", phone: "+96170123456", sports: ["padel", "tennis"] }; mockDb.levels = [{ sport: "padel", level: 5 }]; mockDb.rpcError = null;
  mockPush.mockClear(); mockRpc.mockClear();
});

describe("Profile: details", () => {
  it("shows the contact phone and opens the editor", async () => {
    await show();
    expect(await screen.findByText("+96170123456")).toBeTruthy();
    await fireEvent.press(screen.getByText("Edit your details"));
    expect(mockPush).toHaveBeenCalledWith("/my-details");
    expect(screen.getByText("Delete my account")).toBeTruthy();   // deletion unchanged and still there
  });
  it("no phone yet: says it is needed to book, and offers to add it", async () => {
    mockDb.row = { name: "Rana", phone: null, sports: [] };
    await show();
    expect(await screen.findByText("Not added yet — needed to book a court")).toBeTruthy();
    expect(screen.getByText("Add your details")).toBeTruthy();
  });
});

describe("Profile: sports and levels (optional)", () => {
  it("one chip per sport, with the level or 'Set your level'", async () => {
    await show();
    expect(await screen.findByText("Padel · Level 5 · Intermediate")).toBeTruthy();
    expect(screen.getByText("Tennis · Set your level")).toBeTruthy();
  });
  it("set a level: the sheet saves through set_player_level and the chip updates", async () => {
    await show();
    await fireEvent.press(await screen.findByText("Tennis · Set your level"));
    const sheet = screen.getByTestId("level-sheet");
    await fireEvent.press(within(sheet).getByTestId("level-7"));
    await fireEvent.press(within(sheet).getByTestId("level-save"));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("set_player_level", { p_sport: "tennis", p_level: 7 }));
    expect(await screen.findByText("Tennis · Level 7 · Advanced")).toBeTruthy();
  });
  it("clear a level", async () => {
    await show();
    await fireEvent.press(await screen.findByText("Padel · Level 5 · Intermediate"));
    await fireEvent.press(within(screen.getByTestId("level-sheet")).getByText("Clear level"));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith("set_player_level", { p_sport: "padel", p_level: null }));
    expect(await screen.findByText("Padel · Set your level")).toBeTruthy();
  });
  it("a failed save keeps the sheet open with the reason", async () => {
    mockDb.rpcError = { message: "TypeError: Network request failed" };
    await show();
    await fireEvent.press(await screen.findByText("Tennis · Set your level"));
    await fireEvent.press(within(screen.getByTestId("level-sheet")).getByTestId("level-3"));
    await fireEvent.press(within(screen.getByTestId("level-sheet")).getByTestId("level-save"));
    expect(await screen.findByText("Not saved. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByText("Tennis · Set your level")).toBeTruthy();
  });
  it("no sports yet: explains it is optional and offers to add them", async () => {
    mockDb.row = { name: "Rana", phone: "+96170123456", sports: [] };
    await show();
    expect(await screen.findByText(/Optional — it helps you find games/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Add sports"));
    expect(mockPush).toHaveBeenCalledWith("/my-details");
  });
});
