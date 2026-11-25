/**
 * PR-9b: "Call club" on the cancellation notice. Only the club's own public contact phone is ever dialled (never a
 * staff member's number); a missing, odd or unreadable number falls back to a link to the club's Info tab.
 */
const mockFrom = jest.fn();
jest.mock("../lib/supabase", () => ({ supabase: { from: (...a: unknown[]) => mockFrom(...a), rpc: jest.fn() } }));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));

import { Linking } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { callableClubPhone } from "../lib/clubPhone";
import { ClubContactAction } from "../components/ClubContactAction";

/** supabase.from(table).select(cols).eq(col, val).single() → the answer given; records what was asked. */
const asked: { table: string; cols: string; eq: [string, unknown] }[] = [];
function answer(r: { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>) {
  mockFrom.mockImplementation((table: string) => ({
    select: (cols: string) => ({ eq: (c: string, v: unknown) => { asked.push({ table, cols, eq: [c, v] }); return { single: () => r }; } }),
  }));
}
async function show() {
  // gcTime Infinity schedules no clean-up timer (one would keep Jest from exiting)
  const q = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await render(<QueryClientProvider client={q}><ClubContactAction clubId="c1" clubName="Test Club" /></QueryClientProvider>);
}

beforeEach(() => { asked.length = 0; mockFrom.mockReset(); mockPush.mockReset(); });

describe("callableClubPhone", () => {
  it.each([
    ["+961 6 123 456", "+9616123456"],
    ["06 123 456", "06123456"],
    ["71-123-456", "71123456"],
    ["(06) 123.456", "06123456"],
    ["  +961 71 123 456 ", "+96171123456"],
  ])("%s → tel:%s", (raw, tel) => expect(callableClubPhone(raw)).toBe(tel));
  it.each([
    ["empty", ""], ["spaces", "   "], ["null", null], ["a number type", 6123456],
    ["letters", "call 06 123 456"], ["an extension", "06 123 456 ext 2"], ["too short", "12345"],
    ["too long (over 15 digits)", "+961 1234 5678 9012 3"], ["a + in the middle", "06+123456"], ["two +", "++961 6 123 456"],
  ])("%s: not dialled", (_n, raw) => expect(callableClubPhone(raw)).toBeNull());
});

describe("ClubContactAction", () => {
  it("a callable club phone: Call club dials it", async () => {
    answer({ data: { contact_phone: "+961 6 123 456", contact_email: null }, error: null });
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await show();
    fireEvent.press(await screen.findByTestId("call-club"));
    expect(open).toHaveBeenCalledWith("tel:+9616123456");
    expect(screen.queryByTestId("club-info-link")).toBeNull();
    open.mockRestore();
  });
  it("the phone cannot start a call (openURL fails): the Info tab opens instead, nothing thrown", async () => {
    answer({ data: { contact_phone: "+961 6 123 456" }, error: null });
    const open = jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no dialler"));
    await show();
    fireEvent.press(await screen.findByTestId("call-club"));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith({ pathname: "/club/[id]", params: { id: "c1", name: "Test Club", tab: "info" } }));
    open.mockRestore();
  });
  it("reads clubs.contact_phone only: never a profile (no staff member's number)", async () => {
    answer({ data: { contact_phone: "06 123 456", contact_email: null }, error: null });
    await show();
    await screen.findByTestId("call-club");
    expect(asked).toEqual([{ table: "clubs", cols: "contact_phone", eq: ["id", "c1"] }]);
    expect(mockFrom).not.toHaveBeenCalledWith("profiles");
    expect(mockFrom).not.toHaveBeenCalledWith("club_staff");
  });
  it.each([
    ["no contact phone", { data: { contact_phone: null, contact_email: "desk@club.test" }, error: null }],
    ["a phone that is not dialable", { data: { contact_phone: "ask at reception", contact_email: null }, error: null }],
    ["contact columns missing (older database)", { data: null, error: { code: "42703", message: "column clubs.contact_phone does not exist" } }],
    ["the read failed", { data: null, error: { code: "08006", message: "connection lost" } }],
  ])("%s: a link to the club's Info tab instead", async (_n, r) => {
    answer(r);
    await show();
    fireEvent.press(await screen.findByTestId("club-info-link"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/club/[id]", params: { id: "c1", name: "Test Club", tab: "info" } });
    expect(screen.queryByTestId("call-club")).toBeNull();
  });
  it("while the number is being read: nothing yet (no wrong button flashing)", async () => {
    let release!: (v: { data: unknown; error: null }) => void;
    answer(new Promise<{ data: unknown; error: null }>((r) => { release = r; }));
    await show();
    expect(screen.queryByTestId("call-club")).toBeNull();
    expect(screen.queryByTestId("club-info-link")).toBeNull();
    release({ data: { contact_phone: "06 123 456", contact_email: null }, error: null });   // then it appears
    expect(await screen.findByTestId("call-club")).toBeTruthy();
  });
});
