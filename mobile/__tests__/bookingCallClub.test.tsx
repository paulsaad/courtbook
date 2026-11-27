/**
 * PR-9b: the booking screen's cancellation notice. When it asks the player to tell the club (a pay-at-the-club booking
 * inside the club's cutoff), the club-contact action is there; otherwise it is not.
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

describe("booking screen: a way to tell the club (PR-9b)", () => {
  it("pay at the club, inside the cutoff: the notice says to tell the club, and the contact action is there", async () => {
    await show(booking(2));
    expect(screen.getByText(/please tell the club\.$/)).toBeTruthy();
    expect(screen.getByText("contact-action:c1")).toBeTruthy();
  });
  it("still free to cancel: no contact action", async () => {
    await show(booking(48));
    expect(screen.queryByText(/^contact-action:/)).toBeNull();
  });
  it("a club that takes payment in the app, inside the cutoff (no 'tell the club' notice): no contact action", async () => {
    await show(booking(2, "simulated"));
    expect(screen.queryByText(/please tell the club\.$/)).toBeNull();
    expect(screen.queryByText(/^contact-action:/)).toBeNull();
  });
  it("the booking's club id did not load: no action (never a guessed club)", async () => {
    await show(booking(2, "at_desk", null));
    expect(screen.queryByText(/^contact-action:/)).toBeNull();
  });
});
