/**
 * The booking-fee payment screen (M12.4) with the real PayController and a scripted CourtBook server. The payment page
 * itself (the system browser) and the database rows are stand-ins. What is checked: the screen never says "Court
 * booked" for a held court, the page is opened only from the server's answer, the server is asked after the page
 * closes (whatever happened there), the approved wording is shown, and test mode is labelled.
 */
const mockRows: { booking: Record<string, unknown> | null; payment: Record<string, unknown> | null } = { booking: null, payment: null };
jest.mock("../lib/supabase", () => ({
  supabase: {
    rpc: jest.fn(async () => ({ data: null, error: null })),
    from: jest.fn((table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: table === "bookings" ? mockRows.booking : mockRows.payment, error: null });
      return chain;
    }),
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) },
  },
}));
const mockRouter = { push: jest.fn(), replace: jest.fn(), dismissTo: jest.fn() };
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockRouter.push(...a), replace: (...a: unknown[]) => mockRouter.replace(...a), dismissTo: (...a: unknown[]) => mockRouter.dismissTo(...a) }, Stack: { Screen: () => null }, useLocalSearchParams: () => ({ id: "bk-1" }) }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
jest.mock("../lib/online", () => ({ useOnline: () => true }));
jest.mock("../lib/authRecovery", () => ({ recoverFromAuthFailure: jest.fn() }));
const mockOpen = jest.fn(async (_url: string, _back: string) => ({ type: "dismiss" }));
jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: (u: string, b: string) => mockOpen(u, b) }));
jest.mock("expo-linking", () => ({ createURL: (p: string) => `courtbook://${p}` }));
const mockServer: { sent: Array<{ path: string; body: Record<string, string> }>; answers: Array<{ status: number; body: unknown }> } = { sent: [], answers: [] };
jest.mock("../lib/payments", () => {
  const { PayController } = jest.requireActual("../lib/payController");
  const store = new Map<string, string>();
  let n = 0;
  const ctl = new PayController({
    storage: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => { store.set(k, v); }, removeItem: async (k: string) => { store.delete(k); } },
    post: async (path: string, body: Record<string, string>) => { mockServer.sent.push({ path, body }); return mockServer.answers.shift() ?? null; },
    newKey: () => `key-${++n}`,
    isOnline: () => true,
    now: () => 0,
  });
  return { FEE_PAYMENTS_ON: true, payController: () => ctl };
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Pay from "../app/pay/[id]";
import { FEE_TERMS, TEST_MODE_NOTE } from "../lib/feePayment";

const metrics = { frame: { x: 0, y: 0, width: 360, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 24 } };
const flush = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
const inFuture = () => new Date(Date.now() + 8 * 60_000).toISOString();
const status = (state: string, over: Record<string, unknown> = {}) =>
  ({ status: 200, body: { state, bookingStatus: "pending", paymentStatus: "pending", holdExpiresAt: inFuture(), attempt: null, attemptsLeft: 3, refundsDue: 0, ...over } });

function held(provider = "whish", kind = "fee_only") {
  mockRows.booking = { id: "bk-1", status: "pending", start_at: "2026-12-01T16:00:00Z", end_at: "2026-12-01T17:30:00Z", hold_expires_at: inFuture(), price_usd: 25, fee_usd: 1,
    clubs: { name: "Batroun Padel & Tennis Club", slug: "batroun", timezone: "Asia/Beirut", cancel_cutoff_hours: 6, location_url: null, payment_mode: "fee_online" },
    courts: { name: "Court 1", sport: "padel" } };
  mockRows.payment = { id: "pay-1", status: "pending", total_usd: 1, kind, provider };
}

async function open() {
  const q = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(<SafeAreaProvider initialMetrics={metrics}><QueryClientProvider client={q}><Pay /></QueryClientProvider></SafeAreaProvider>);
  await waitFor(() => expect(screen.queryByLabelText("Loading your booking")).toBeNull());
  await flush();
}

beforeEach(() => { mockServer.sent = []; mockServer.answers = []; mockOpen.mockClear(); mockRouter.replace.mockClear(); });

it("a held court: the fee to pay, the court price paid at the club, the approved terms — never 'Court booked'", async () => {
  held();
  mockServer.answers = [status("awaiting_payment")];
  await open();
  expect(screen.getByText("Pay the booking fee to confirm")).toBeTruthy();
  expect(screen.getByText("Pay at the club")).toBeTruthy();
  expect(screen.getByText("Pay online now")).toBeTruthy();
  expect(screen.getByText(FEE_TERMS)).toBeTruthy();
  expect(screen.queryByText(/Court booked/)).toBeNull();
  expect(screen.getByText(/Held for you for \d:\d\d/)).toBeTruthy();
  expect(screen.getByTestId("pay-abandon")).toBeTruthy();
  expect(screen.queryByText(TEST_MODE_NOTE)).toBeNull();          // a real provider: no test-mode note
  expect(mockServer.sent.map((s) => s.path)).toEqual(["/api/native/pay/status"]);   // opening the screen only reads
});

it("Pay: the server's page opens with the app's return link; afterwards the server is asked, and an open page is never 'booked'", async () => {
  held();
  mockServer.answers = [status("awaiting_payment"), { status: 200, body: { redirect: "https://pay.example/s/1" } }, status("payment_open", { attempt: { status: "open", outcome: null, attemptNo: 1 }, attemptsLeft: 2 })];
  await open();
  await act(async () => { fireEvent.press(screen.getByTestId("pay-primary")); });
  await flush();
  expect(mockOpen).toHaveBeenCalledWith("https://pay.example/s/1", "courtbook://payment-return");
  expect(mockServer.sent.map((s) => s.path)).toEqual(["/api/native/pay/status", "/api/native/pay/start", "/api/native/pay/status"]);
  expect(mockServer.sent[1].body).toEqual({ paymentId: "pay-1", requestKey: "key-1" });
  expect(screen.getByText("Payment in progress")).toBeTruthy();
  expect(screen.getByText("Continue payment")).toBeTruthy();
  expect(screen.queryByTestId("pay-abandon")).toBeNull();         // no releasing while money may still be taken
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it("confirmed by the server → the booking's confirmation screen", async () => {
  held();
  mockServer.answers = [status("confirmed", { bookingStatus: "confirmed", paymentStatus: "paid" })];
  await open();
  await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
  expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: "/booking/[id]", params: { id: "bk-1", new: "1" } });
});

it("a provider timeout: says not to pay again; the page is not opened and nothing is retried", async () => {
  held();
  mockServer.answers = [status("awaiting_payment"), { status: 502, body: { error: "payment_uncertain", final: false } }, status("checking")];
  await open();
  await act(async () => { fireEvent.press(screen.getByTestId("pay-primary")); });
  await flush();
  expect(mockOpen).not.toHaveBeenCalled();
  expect(screen.getByText(/Don't pay again/)).toBeTruthy();
  expect(screen.getByText("Checking your payment")).toBeTruthy();
  expect(mockServer.sent.filter((s) => s.path.endsWith("/start"))).toHaveLength(1);
});

it("a demo club's simulated provider is labelled as test mode", async () => {
  held("simulated");
  mockServer.answers = [status("awaiting_payment")];
  await open();
  expect(screen.getByText(TEST_MODE_NOTE)).toBeTruthy();
});

it("a Model 1 (court and fee online) payment is not handled here: the website", async () => {
  held("simulated", "court_and_fee");
  await open();
  expect(screen.getByText("Finish this booking on the website")).toBeTruthy();
  expect(mockServer.sent).toEqual([]);
});
