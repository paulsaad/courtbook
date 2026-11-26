/**
 * N5 (Session B's pilot acceptance package; Paul 26 Nov: should-fix before the A17 test, checklist step 6.2): a cancelled
 * pay-at-desk booking still showed "Payment | $30 at the club | Nothing was charged in the app". As the website (#93, H9):
 * the pay-at-club line only while the booking is confirmed.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), dismissTo: jest.fn() }, Stack: { Screen: () => null }, useLocalSearchParams: () => ({ id: "b1" }) }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", userId: "me" }) }));
jest.mock("../lib/cancel", () => ({ useCancellation: () => ({ phase: "idle", problem: null, submit: jest.fn(), check: jest.fn() }) }));
jest.mock("../components/ClubContactAction", () => {
  const { Text } = jest.requireActual("react-native");
  return { ClubContactAction: ({ clubId }: { clubId: string }) => <Text>{`contact-action:${clubId}`}</Text> };
});
const mockBooking: { current: unknown } = { current: null };
jest.mock("../lib/bookings", () => ({
  ...jest.requireActual("../lib/bookings"),
  useBooking: () => ({ isPending: false, isError: false, data: mockBooking.current, refetch: jest.fn() }),
  usePayment: () => ({ data: undefined }),
}));

import { render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Booking from "../app/booking/[id]";

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
function booking(startInHours: number, mode = "at_desk", clubId: string | null = "c1") {
  return {
    id: "b1", club_id: clubId, status: "confirmed", start_at: inHours(startInHours), end_at: inHours(startInHours + 1.5), price_usd: 30, fee_usd: 0,
    club: { name: "Test Club", slug: "test", timezone: "Asia/Beirut", cancel_cutoff_hours: 6, location_url: null, payment_mode: mode, lat: null, lng: null },
    court: { name: "Court 1", sport: "padel" },
  };
}
async function show(b: unknown) {
  mockBooking.current = b;
  await render(<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}><Booking /></SafeAreaProvider>);
}

describe("booking screen: what a pay-at-desk booking says about paying (N5)", () => {
  it("confirmed: $30 at the club, nothing charged in the app (unchanged)", async () => {
    await show(booking(48));
    expect(screen.getByText("$30 at the club")).toBeTruthy();
    expect(screen.getByText("Nothing was charged in the app")).toBeTruthy();
  });
  it.each(["cancelled", "no_show", "expired"])("%s: no 'at the club' payment line; 'Nothing was paid through CourtBook'", async (status) => {
    await show({ ...booking(48), status });
    expect(screen.queryByText(/at the club/)).toBeNull();
    expect(screen.queryByText("Nothing was charged in the app")).toBeNull();
    expect(screen.getByText("Nothing was paid through CourtBook")).toBeTruthy();
  });
  it("cancelled by the desk, seen on return (same booking row, status changed): no pay line", async () => {
    await show({ ...booking(2), status: "cancelled" });
    expect(screen.queryByText(/\$30 at the club/)).toBeNull();
  });
  it("a club that takes payment in the app: unchanged (Paid row)", async () => {
    await show({ ...booking(48, "simulated"), status: "cancelled" });
    expect(screen.queryByText("Nothing was paid through CourtBook")).toBeNull();
    // M12 line: an in-app club's payment row waits for its payment record (M12.4), so no "Paid" without one
  });
});
