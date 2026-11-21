import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";

export type BookingDetail = {
  id: string; status: string; start_at: string; end_at: string; price_usd: number | null; fee_usd: number | null;
  club: { name: string; slug: string; timezone: string; cancel_cutoff_hours: number; location_url: string | null; payment_mode: string | null };
  court: { name: string; sport: string } | null;
};

/** One of the player's own bookings (row-level security returns only their own). */
export function useBooking(id: string | undefined) {
  return useQuery({
    queryKey: ["booking", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bookings")
        .select("id, status, start_at, end_at, price_usd, fee_usd, clubs(name, slug, timezone, cancel_cutoff_hours, location_url, payment_mode), courts!bookings_court_id_fkey(name, sport)")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const d = data as unknown as Record<string, unknown>;
      return { ...(d as object), club: d.clubs, court: d.courts } as unknown as BookingDetail;
    },
  });
}

export type AgendaRow = {
  kind: "booking" | "match"; id: string; start_at: string; end_at: string | null; club_name: string; club_slug: string;
  timezone: string; title: string | null; status: string; role: string | null;
};

export function useAgenda(enabled: boolean) {
  return useQuery({
    queryKey: ["my-agenda"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_agenda");
      if (error) throw error;
      return (data ?? []) as AgendaRow[];
    },
  });
}

/** Free cancellation ends cancel_cutoff_hours before the start — the same rule cancel_booking applies. */
export function cancellation(startAt: string, cutoffHours: number, now = Date.now()) {
  const cutoffAt = new Date(Date.parse(startAt) - cutoffHours * 3_600_000);
  return { cutoffAt, free: cutoffAt.getTime() > now };
}

/**
 * How a row in Bookings shows its state: one colour AND one word, never colour alone.
 *   confirmed (green)  — an upcoming confirmed booking, or an upcoming game you are in or organise
 *   waiting   (amber)  — an upcoming game whose organiser has not accepted you yet
 *   cancelled (red)    — cancelled booking or game (danger red, not the brand red)
 *   past      (neutral)— finished, or marked a no-show by the club
 * Display only: it reads the status the database returns and changes nothing.
 */
export type RowTone = "confirmed" | "waiting" | "cancelled" | "past";
export function rowStatus(r: AgendaRow, now = Date.now()): { tone: RowTone; label: string } {
  if (r.status === "cancelled") return { tone: "cancelled", label: "Cancelled" };
  if (r.status === "no_show") return { tone: "past", label: "No-show" };
  if (Date.parse(r.end_at ?? r.start_at) <= now) return { tone: "past", label: r.kind === "match" ? "Played" : "Completed" };
  if (r.kind === "match") {
    if (r.role === "pending") return { tone: "waiting", label: "Waiting for the organiser" };
    return { tone: "confirmed", label: r.role === "organizer" ? "You're organising" : "You're in" };
  }
  return { tone: "confirmed", label: "Confirmed" };
}

export function splitAgenda(rows: AgendaRow[], now = Date.now()) {
  const end = (r: AgendaRow) => Date.parse(r.end_at ?? r.start_at);
  const upcoming = rows.filter((r) => end(r) > now && r.status !== "cancelled").sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const past = rows.filter((r) => !(end(r) > now && r.status !== "cancelled")).sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  return { upcoming, past };
}

/** The payment behind a booking at a club that takes payment in the app (none for pay-at-the-club). */
export function usePayment(bookingId: string | undefined) {
  return useQuery({
    queryKey: ["payment", bookingId],
    enabled: !!bookingId,
    queryFn: async () => {
      const { data, error } = await supabase.from("payments").select("status, total_usd").eq("booking_id", bookingId!).maybeSingle();
      if (error) throw error;
      return data as { status: string; total_usd: number | null } | null;
    },
  });
}
