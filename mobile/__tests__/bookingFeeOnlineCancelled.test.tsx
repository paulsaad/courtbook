/**
 * M12 line only (Paul 26 Nov: the missing regression test for #99's resolution on this branch). A fee_online booking
 * (CourtBook fee paid online, court paid at the club): after cancellation the screen must not say to pay the court at
 * the club. The CourtBook fee line stays (paid, kept, or refunded). Payments stay disabled on the pilot line.
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
const mockPay: { current: { isSuccess: boolean; isError: boolean; data: unknown } } = { current: { isSuccess: true, isError: false, data: null } };
jest.mock("../lib/bookings", () => ({
  ...jest.requireActual("../lib/bookings"),
  useBooking: () => ({ isPending: false, isError: false, data: mockBooking.current, refetch: jest.fn() }),
  usePayment: () => mockPay.current,
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

const feeOnline = (status: string) => ({ ...booking(48, "fee_online"), status, fee_usd: 1 });
const feePaid = (status: string) => ({ isSuccess: true, isError: false, data: { kind: "fee_only", status, total_usd: 1 } });

describe("M12 booking screen: a fee_online booking after cancellation (#99 resolution)", () => {
  it("confirmed: court price to pay at the club, and the fee paid online (unchanged)", async () => {
    mockPay.current = feePaid("paid");
    await show(feeOnline("confirmed"));
    expect(screen.getByText("Court price")).toBeTruthy();
    expect(screen.getByText("Pay at the club")).toBeTruthy();
    expect(screen.getByText("$1.00 paid")).toBeTruthy();
  });
  it("cancelled by the player (fee kept): no court price to pay at the club; the fee line stays", async () => {
    mockPay.current = feePaid("paid");
    await show(feeOnline("cancelled"));
    expect(screen.queryByText("Court price")).toBeNull();
    expect(screen.queryByText(/at the club/)).toBeNull();
    expect(screen.getByText("$1.00 paid")).toBeTruthy();
  });
  it("cancelled by the club (fee refunded): no court price; the refund is said", async () => {
    mockPay.current = feePaid("refund_due");
    await show(feeOnline("cancelled"));
    expect(screen.queryByText(/at the club/)).toBeNull();
    expect(screen.getByText("$1.00 refund due")).toBeTruthy();
  });
  it.each(["no_show", "expired"])("%s: no court price to pay at the club", async (status) => {
    mockPay.current = feePaid(status === "expired" ? "expired" : "paid");
    await show(feeOnline(status));
    expect(screen.queryByText(/at the club/)).toBeNull();
  });
  it("a fee_online club whose booking has no payment record (treated as the desk): cancelled says nothing was paid", async () => {
    mockPay.current = { isSuccess: true, isError: false, data: null };
    await show(feeOnline("cancelled"));
    expect(screen.queryByText(/at the club/)).toBeNull();
    expect(screen.getByText("Nothing was paid through CourtBook")).toBeTruthy();
  });
});
