import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { DaySlot } from "./courts";

/** All Lebanon for now; the area filter comes with the Home screen. */
export const BEIRUT = "Asia/Beirut";

export function useDaySlots(date: string, sport: string | null) {
  return useQuery({
    queryKey: ["day-slots", date, sport],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("club_day_slots", {
        p_date: date, p_sport: sport, p_governorate: null, p_district: null, p_query: null,
      });
      if (error) throw error;
      return (data ?? []) as DaySlot[];
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
