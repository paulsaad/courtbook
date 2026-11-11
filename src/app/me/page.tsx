import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { nowMs } from "@/lib/time";
import BookingsTabs from "./BookingsTabs";
import type { AgendaRow } from "@/lib/agenda";

export type { AgendaRow } from "@/lib/agenda";

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
