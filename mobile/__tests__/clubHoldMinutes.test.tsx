// The app told players at fee-online clubs that the court is held "for 10 minutes" whatever the club set (clubs.hold_minutes,
// 2–30, what hold_slot really uses and the website shows). The hold length now comes from the club.
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";

const mockSingle = jest.fn();
const mockSelect = jest.fn((..._cols: unknown[]) => ({ eq: () => ({ single: mockSingle }) }));
jest.mock("../lib/supabase", () => ({ supabase: { from: () => ({ select: (...a: unknown[]) => mockSelect(...(a as [])) }), rpc: jest.fn() } }));

import { useClubPayment } from "../lib/queries";
import { feeOnlineNote } from "../lib/panelText";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("how long a fee-online club holds the court while the player pays", () => {
  it("reads the club's own hold length with its payment mode and fee", async () => {
    mockSingle.mockResolvedValueOnce({ data: { payment_mode: "fee_online", service_fee_usd: 1.5, hold_minutes: 5 }, error: null });
    const { result } = await renderHook(() => useClubPayment("club-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ mode: "fee_online", fee: 1.5, holdMinutes: 5 });
    expect(String(mockSelect.mock.calls.at(-1)?.[0])).toContain("hold_minutes");
  });
  it("an unreadable hold length is unknown, not 10", async () => {
    mockSingle.mockResolvedValueOnce({ data: { payment_mode: "fee_online", service_fee_usd: 1, hold_minutes: null }, error: null });
    const { result } = await renderHook(() => useClubPayment("club-2"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.holdMinutes).toBeNull();
  });
  it("the note says the club's number of minutes, the same as the website", () => {
    expect(feeOnlineNote("$1.50", 5)).toContain("held for 5 minutes while you pay");
    expect(feeOnlineNote("$1.50", 30)).toContain("held for 30 minutes");
    expect(feeOnlineNote("$1.50", null)).not.toMatch(/\d+ minutes/);
    expect(feeOnlineNote("$1.50", 5)).toContain("The fee is not refunded if you cancel; it is refunded if the club cancels");
  });
});
