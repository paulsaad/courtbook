/**
 * "Before you book" and "Your details" (Paul, 26 Nov): only missing fields before a booking, international phones,
 * the number treated as the player's own (not verified, not assumed WhatsApp), editing later, failures said in words.
 * The database side (own row only, closed accounts locked out) is the existing profiles policy and 0086 trigger.
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockDb = {
  row: { name: null as string | null, phone: null as string | null, sports: [] as string[] },
  readError: null as unknown,
  updateError: null as unknown,
  updated: [] as unknown[],
};
jest.mock("../lib/supabase", () => ({
  supabase: {
    rpc: jest.fn(),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => (mockDb.readError ? { data: null, error: mockDb.readError } : { data: { ...mockDb.row }, error: null }) }) }),
      update: (patch: unknown) => ({
        eq: () => ({
          select: async () => {
            if (mockDb.updateError) return { data: null, error: mockDb.updateError };
            mockDb.updated.push(patch);
            return { data: [{ id: "me" }], error: null };
          },
        }),
      }),
    }),
  },
}));
const mockBack = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({ router: { back: () => mockBack(), push: jest.fn() }, Stack: { Screen: () => null }, useLocalSearchParams: () => mockParams }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));

import MyDetails from "../app/my-details";
import { sportsKey } from "../lib/sports";

async function wrap(el: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  return {
    qc,
    ...(await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <QueryClientProvider client={qc}>{el}</QueryClientProvider>
      </SafeAreaProvider>,
    )),
  };
}

beforeEach(() => {
  mockDb.row = { name: null, phone: null, sports: [] }; mockDb.readError = null; mockDb.updateError = null; mockDb.updated = [];
  mockBack.mockClear(); mockParams = {};
});

describe("before the first court booking", () => {
  beforeEach(() => { mockParams = { for: "booking" }; });

  it("asks only for the phone when the name is known; says it is not verified and not WhatsApp-specific", async () => {
    mockDb.row = { name: "Rana Khoury", phone: null, sports: [] };
    await wrap(<MyDetails />);
    await screen.findByTestId("details-phone");
    expect(screen.queryByTestId("details-name")).toBeNull();
    expect(screen.getByText(/We don't verify it/)).toBeTruthy();
    expect(screen.queryByText(/WhatsApp/)).toBeNull();
    expect(screen.getByText("Save and continue")).toBeTruthy();
  });

  it("both missing: both asked; empty → two clear errors, nothing saved, no return to the club", async () => {
    await wrap(<MyDetails />);
    await screen.findByTestId("details-name");
    await fireEvent.press(screen.getByTestId("details-save"));
    expect(await screen.findByText("Enter your name, as the club should see it.")).toBeTruthy();
    expect(screen.getByText("Enter a phone number the club can reach you on.")).toBeTruthy();
    expect(mockDb.updated).toEqual([]);
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("a Swedish number saves in international form and returns to the booking", async () => {
    const { qc } = await wrap(<MyDetails />);
    await fireEvent.changeText(await screen.findByTestId("details-name"), "  Erik Lund ");
    await fireEvent.changeText(screen.getByTestId("details-phone"), "+46 70 123 45 67");
    expect(screen.getByText("Saved as +46701234567")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("details-save"));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockDb.updated).toEqual([{ name: "Erik Lund", phone: "+46701234567" }]);
    // the club screen reads this to finish the reservation without asking again
    expect(qc.getQueryData(["my-profile", "me"])).toMatchObject({ name: "Erik Lund", phone: "+46701234567" });
  });

  it("a local Swedish number without the country code: told what to do, nothing saved", async () => {
    mockDb.row = { name: "Erik", phone: null, sports: [] };
    await wrap(<MyDetails />);
    await fireEvent.changeText(await screen.findByTestId("details-phone"), "070-123 45 67");
    await fireEvent.press(screen.getByTestId("details-save"));
    expect(await screen.findByText(/start with \+ and the country code/)).toBeTruthy();
    expect(mockDb.updated).toEqual([]);
  });

  it("a failed save stays on the screen with the reason; no return, no booking", async () => {
    mockDb.row = { name: "Rana", phone: null, sports: [] };
    mockDb.updateError = { message: "TypeError: Network request failed", code: "" };
    await wrap(<MyDetails />);
    await fireEvent.changeText(await screen.findByTestId("details-phone"), "70 123 456");
    await fireEvent.press(screen.getByTestId("details-save"));
    expect(await screen.findByText("Not saved. Check your connection and try again.")).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("a closed account cannot change its details (0086), and is told so", async () => {
    mockDb.row = { name: "Rana", phone: null, sports: [] };
    mockDb.updateError = { message: "account_closed", code: "P0001" };
    await wrap(<MyDetails />);
    await fireEvent.changeText(await screen.findByTestId("details-phone"), "70 123 456");
    await fireEvent.press(screen.getByTestId("details-save"));
    expect(await screen.findByText(/This account is closed/)).toBeTruthy();
  });

  it("nothing missing any more (filled on another device): straight back to the booking, no form", async () => {
    mockDb.row = { name: "Rana", phone: "+96170123456", sports: [] };
    await wrap(<MyDetails />);
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it("details could not be read: the error with Try again, never an empty form", async () => {
    mockDb.readError = { message: "TypeError: Network request failed", code: "" };
    await wrap(<MyDetails />);
    expect(await screen.findByText("Try again")).toBeTruthy();
    expect(screen.queryByTestId("details-phone")).toBeNull();
  });
});

describe("editing later, from Profile", () => {
  it("sport chips come from the catalogue, alphabetical; a player's own deactivated sport stays removable (#66 review SF2)", async () => {
    mockDb.row = { name: "Rana", phone: "+96170123456", sports: ["squash"] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
    qc.setQueryData(sportsKey, [{ code: "cricket", name: "Cricket" }, { code: "padel", name: "Padel" }, { code: "table_tennis", name: "Table tennis" }], { updatedAt: Date.now() + 864e5 });
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <QueryClientProvider client={qc}><MyDetails /></QueryClientProvider>
      </SafeAreaProvider>,
    );
    await screen.findByTestId("details-name");
    const labels = ["Cricket", "Padel", "Table tennis", "Squash", "Tennis"].filter((l) => screen.queryByText(l));
    expect(labels).toEqual(["Cricket", "Padel", "Table tennis", "Squash"]);   // added in the dashboard: shown; Tennis not in it: not offered
    await fireEvent.press(screen.getByText("Squash"));
    await fireEvent.press(screen.getByText("Cricket"));
    await fireEvent.press(screen.getByTestId("details-save"));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockDb.updated).toEqual([{ name: "Rana", phone: "+96170123456", sports: ["cricket"] }]);
  });

  it("shows the saved details and optional sports; saves changes", async () => {
    mockDb.row = { name: "Rana Khoury", phone: "+96170123456", sports: ["padel"] };
    await wrap(<MyDetails />);
    expect((await screen.findByTestId("details-name")).props.value).toBe("Rana Khoury");
    expect(screen.getByTestId("details-phone").props.value).toBe("+96170123456");
    expect(screen.getByText("Sports you play (optional)")).toBeTruthy();
    await fireEvent.press(screen.getByText("Tennis"));
    await fireEvent.changeText(screen.getByTestId("details-phone"), "+961 3 123 456");
    await fireEvent.press(screen.getByTestId("details-save"));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockDb.updated).toEqual([{ name: "Rana Khoury", phone: "+9613123456", sports: ["padel", "tennis"] }]);
  });

  it("the phone may be removed when editing (then the next booking asks again)", async () => {
    mockDb.row = { name: "Rana", phone: "+96170123456", sports: [] };
    await wrap(<MyDetails />);
    await fireEvent.changeText(await screen.findByTestId("details-phone"), "");
    await fireEvent.press(screen.getByTestId("details-save"));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockDb.updated).toEqual([{ name: "Rana", phone: null, sports: [] }]);
  });
});
