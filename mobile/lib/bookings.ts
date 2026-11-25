import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";

export type BookingDetail = {
  id: string; club_id: string; status: string; start_at: string; end_at: string; price_usd: number | null; fee_usd: number | null;
  hold_expires_at?: string | null;
  club: { name: string; slug: string; timezone: string; cancel_cutoff_hours: number; location_url: string | null; payment_mode: string | null; lat?: number | string | null; lng?: number | string | null };
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
        .select("id, club_id, status, start_at, end_at, hold_expires_at, price_usd, fee_usd, clubs(name, slug, timezone, cancel_cutoff_hours, location_url, payment_mode, lat, lng), courts!bookings_court_id_fkey(name, sport)")
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
 *   unknown   (neutral)— any status or role this version does not know: "See details", never green
 * Green is given only for exact known values, so a status added later can never read as confirmed.
 * Display only: it reads the status the database returns and changes nothing.
 */
export type RowTone = "confirmed" | "waiting" | "cancelled" | "past";
const UNKNOWN = { tone: "past", label: "See details" } as const;
const GAME_STATUSES = new Set(["open", "closed"]);
export function rowStatus(r: AgendaRow, now = Date.now()): { tone: RowTone; label: string } {
  if (r.status === "cancelled") return { tone: "cancelled", label: "Cancelled" };
  const ended = Date.parse(r.end_at ?? r.start_at) <= now;
  if (r.kind === "booking") {
    if (r.status === "no_show") return { tone: "past", label: "No-show" };
    if (r.status !== "confirmed") return UNKNOWN;
    return ended ? { tone: "past", label: "Completed" } : { tone: "confirmed", label: "Confirmed" };
  }
  if (!GAME_STATUSES.has(r.status)) return UNKNOWN;
  if (ended) return { tone: "past", label: "Played" };
  if (r.role === "organizer") return { tone: "confirmed", label: "You're organising" };
  if (r.role === "accepted") return { tone: "confirmed", label: "You're in" };
  if (r.role === "pending") return { tone: "waiting", label: "Waiting for the organiser" };
  return UNKNOWN;
}

export function splitAgenda(rows: AgendaRow[], now = Date.now()) {
  const end = (r: AgendaRow) => Date.parse(r.end_at ?? r.start_at);
  const upcoming = rows.filter((r) => end(r) > now && r.status !== "cancelled").sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
  const past = rows.filter((r) => !(end(r) > now && r.status !== "cancelled")).sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at));
  return { upcoming, past };
}

/** The payment behind a booking at a club that takes payment in the app (none for pay-at-the-club). */
/** The player's own payment row for a booking. kind: 'fee_only' (Model 2: only the CourtBook fee online, M12.1) or
 *  'court_and_fee' (Model 1 demo clubs). provider 'simulated' means no real money. */
export type BookingPayment = { id: string; status: string; total_usd: number | null; kind: "fee_only" | "court_and_fee" | string; provider: string };
export function usePayment(bookingId: string | undefined) {
  return useQuery({
    queryKey: ["payment", bookingId],
    enabled: !!bookingId,
    queryFn: async () => {
      // "*", not a column list: `kind` exists only from 0094 on, and naming it would break this screen against a database
      // without it (Model 1 demo bookings). Missing → "court_and_fee", the only kind before 0094.
      const { data, error } = await supabase.from("payments").select("*").eq("booking_id", bookingId!).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return { id: String(r.id), status: String(r.status), total_usd: r.total_usd == null ? null : Number(r.total_usd),
        kind: typeof r.kind === "string" ? r.kind : "court_and_fee", provider: String(r.provider ?? "") } as BookingPayment;
    },
  });
}
