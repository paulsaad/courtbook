import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { nowMs } from "@/lib/time";
import BookingsTabs from "./BookingsTabs";

export type AgendaRow = { kind: "booking" | "match"; id: string; start_at: string; end_at: string | null; club_name: string; club_slug: string; timezone: string; title: string | null; status: string; role: string | null };

export function agendaPill(r: AgendaRow) {
  if (r.kind === "booking") return r.status === "confirmed" ? ["booked", "bg-turf-soft text-turf"] : r.status === "no_show" ? ["no-show", "bg-slate-soft text-muted"] : ["cancelled", "bg-slate-soft text-muted"];
  if (r.status === "cancelled") return ["cancelled", "bg-slate-soft text-muted"];
  if (r.role === "organizer") return ["your match", "bg-sand-soft text-ink"];
  if (r.role === "pending") return ["requested", "bg-sand-soft text-ink"];
  return ["you're in", "bg-turf-soft text-turf"];
}

export default async function MyCourtBook() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/me");
  const { data } = await supabase.rpc("my_agenda");
  const rows = (data ?? []) as AgendaRow[];
  const now = nowMs();
  const live = (r: AgendaRow) => r.status !== "cancelled" && r.status !== "no_show" && new Date(r.end_at ?? r.start_at).getTime() > now;
  const upcoming = rows.filter(live).sort((a, b) => a.start_at.localeCompare(b.start_at));
  const past = rows.filter((r) => !live(r));

  const bookings = upcoming.filter((r) => r.kind === "booking");
  const matchesUp = upcoming.filter((r) => r.kind === "match");
  return <BookingsTabs bookings={bookings} matches={matchesUp} past={past.slice(0, 50)} />;
}
