import { useQuery } from "@tanstack/react-query";
import { areaFilter, type PlayingArea } from "@shared/places";
import { supabase } from "./supabase";
import type { DaySlot } from "./courts";

/** All Lebanon for now; the area filter comes with the Home screen. */
export const BEIRUT = "Asia/Beirut";

/** One day's free starts. An area narrows it: the function filters by governorate or district; a town by name (0088). */
export function useDaySlots(date: string, sport: string | null, area: PlayingArea | null = null) {
  const f = areaFilter(area);
  return useQuery({
    queryKey: ["day-slots", date, sport, f.p_governorate, f.p_district, f.townName],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("club_day_slots", {
        p_date: date, p_sport: sport, p_governorate: f.p_governorate, p_district: f.p_district, p_query: null,
      });
      if (error) throw error;
      const rows = (data ?? []) as DaySlot[];
      return f.townName ? rows.filter((r) => r.town === f.townName) : rows;
    },
  });
}

/** The server's price for one court, start and duration — the only price the app shows as a total. */
export function useQuote(courtId: string | null, start: string | null, minutes: number | null) {
  return useQuery({
    queryKey: ["quote", courtId, start, minutes],
    enabled: !!courtId && !!start && !!minutes,
    queryFn: async () => {
      const s = new Date(start!);
      const e = new Date(s.getTime() + minutes! * 60_000);
      const { data, error } = await supabase.rpc("quote_price", { p_court: courtId, p_start: s.toISOString(), p_end: e.toISOString() });
      if (error) throw error;
      return Number(data);
    },
  });
}

/** How the club settles money. club_day_slots does not carry it; read like the website does. */
/** The club's payment mode and CourtBook fee, read fresh (M12.4: the fee decides whether a fee_online booking needs
 *  the payment screen; $0 confirms at once). Unknown mode → "simulated", which the app never reserves. */
export function useClubPayment(clubId: string | null) {
  return useQuery({
    queryKey: ["club-payment", clubId],
    enabled: !!clubId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("clubs").select("payment_mode, service_fee_usd, hold_minutes").eq("id", clubId!).single();
      if (error) throw error;
      const fee = Number(data?.service_fee_usd);
      // how long hold_slot keeps the court for payment: the club's own setting (2–30 minutes), never assumed
      const hold = Number(data?.hold_minutes);
      return { mode: (data?.payment_mode as string | null) ?? "simulated", fee: Number.isFinite(fee) && fee >= 0 ? fee : null,
        holdMinutes: Number.isInteger(hold) && hold > 0 ? hold : null };
    },
  });
}

/** The player's live court hold, if any (my_active_hold, 0013): one at a time. */
export function useActiveHold(enabled: boolean) {
  return useQuery({
    queryKey: ["active-hold"],
    enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_active_hold");
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string; hold_expires_at: string; club_slug: string } | null | undefined;
      return row ?? null;
    },
  });
}

export function useClubMode(clubId: string | null) {
  return useQuery({
    queryKey: ["club-mode", clubId],
    enabled: !!clubId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("clubs").select("payment_mode").eq("id", clubId!).single();
      if (error) throw error;
      return (data?.payment_mode as string | null) ?? "simulated";
    },
  });
}

export type CourtPrice = { price: number | null; error: string | null };
export type TilePrices = Map<string, Map<string, CourtPrice>>; // start (ISO) -> court id -> price

/**
 * The server's price for every free court at every shown time, so tiles can show real prices.
 * quote_price prefers a court's own rule over the club's, so courts can differ: each free court is
 * quoted, never inferred from another. Calls run a few at a time; one failure marks only its court.
 */
export function useTilePrices(clubId: string | null, minutes: number | null, tiles: { start: string; freeCourts: { id: string }[] }[]) {
  const pairs = tiles.flatMap((t) => t.freeCourts.map((c) => ({ start: t.start, court: c.id })));
  const signature = pairs.map((p) => `${p.start}/${p.court}`).join(",");
  return useQuery({
    queryKey: ["tile-prices", clubId, minutes, signature],
    enabled: !!clubId && !!minutes && pairs.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const out: TilePrices = new Map();
      let i = 0;
      async function worker() {
        while (i < pairs.length) {
          const p = pairs[i++];
          const s = new Date(p.start);
          const e = new Date(s.getTime() + minutes! * 60_000);
          const { data, error } = await supabase.rpc("quote_price", { p_court: p.court, p_start: s.toISOString(), p_end: e.toISOString() });
          const row = out.get(p.start) ?? new Map<string, CourtPrice>();
          row.set(p.court, error ? { price: null, error: error.message } : { price: Number(data), error: null });
          out.set(p.start, row);
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, pairs.length) }, worker));
      return out;
    },
  });
}

/** "$30", "from $24" when free courts differ, or null while unknown. */
export function tilePriceLabel(prices: Map<string, CourtPrice> | undefined): string | null {
  if (!prices) return null;
  const known = [...prices.values()].map((p) => p.price).filter((p): p is number => p !== null);
  if (known.length === 0) return null;
  const min = Math.min(...known), max = Math.max(...known);
  return min === max ? money(min) : `from ${money(min)}`;
}

export function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}
