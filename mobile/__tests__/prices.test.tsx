jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { supabase } from "../lib/supabase";
import { money, tilePriceLabel, useTilePrices } from "../lib/queries";

const rpc = supabase.rpc as jest.Mock;

describe("money", () => {
  it("drops cents only when there are none", () => {
    expect(money(30)).toBe("$30");
    expect(money(30.5)).toBe("$30.50");
  });
});

describe("tilePriceLabel", () => {
  it("shows one price when every free court costs the same, and 'from' when they differ", () => {
    expect(tilePriceLabel(new Map([["a", { price: 30, error: null }], ["b", { price: 30, error: null }]]))).toBe("$30");
    expect(tilePriceLabel(new Map([["a", { price: 36, error: null }], ["b", { price: 24, error: null }]]))).toBe("from $24");
  });
  it("shows nothing rather than a guess when no price is known", () => {
    expect(tilePriceLabel(undefined)).toBeNull();
    expect(tilePriceLabel(new Map([["a", { price: null, error: "no_price_rule" }]]))).toBeNull();
  });
});

describe("useTilePrices", () => {
  it("asks the server for the exact court, start and end of every free court at every time", async () => {
    rpc.mockImplementation((_fn: string, a: { p_court: string; p_start: string; p_end: string }) =>
      Promise.resolve(a.p_court === "c2" ? { data: null, error: { message: "no_price_rule" } } : { data: a.p_court === "c1" ? 30 : 24, error: null }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const tiles = [
      { start: "2026-11-14T16:00:00.000Z", freeCourts: [{ id: "c1" }, { id: "c3" }] },
      { start: "2026-11-14T16:30:00.000Z", freeCourts: [{ id: "c2" }] },
    ];
    const { result } = await renderHook(() => useTilePrices("club", 90, tiles), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpc).toHaveBeenCalledWith("quote_price", { p_court: "c1", p_start: "2026-11-14T16:00:00.000Z", p_end: "2026-11-14T17:30:00.000Z" });
    expect(rpc).toHaveBeenCalledTimes(3);
    const m = result.current.data!;
    expect(m.get("2026-11-14T16:00:00.000Z")!.get("c3")).toEqual({ price: 24, error: null });
    expect(tilePriceLabel(m.get("2026-11-14T16:00:00.000Z"))).toBe("from $24");
    expect(m.get("2026-11-14T16:30:00.000Z")!.get("c2")).toEqual({ price: null, error: "no_price_rule" });
  });
});
