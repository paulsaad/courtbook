import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { dayBounds, todayIn } from "@/lib/time";
import type { Club, Court } from "@/lib/types";
import PlayerGrid, { type Occ } from "./PlayerGrid";

export default async function ClubPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { slug } = await params;
  const { date: qDate } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/club/${slug}`);

  const { data: club } = await supabase
    .from("clubs")
    .select("id, name, slug, timezone, slot_minutes, cancel_cutoff_hours, open_time, close_time, min_booking_minutes, max_booking_minutes, booking_window_days, service_fee_usd, location_url, hold_minutes")
    .eq("slug", slug)
    .eq("active", true)
    .single<Club & { booking_window_days: number; service_fee_usd: number; location_url: string | null; hold_minutes: number }>();
  if (!club) notFound();

  const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : todayIn(club.timezone);
  const { dayStart, dayEnd } = dayBounds(date, club.timezone);

  const [{ data: courts }, { data: occ }] = await Promise.all([
    supabase.from("courts").select("id, name, sport, surface, sort, active").eq("club_id", club.id).eq("active", true).order("sort"),
    supabase.from("occupancy").select("id, court_id, start_at, end_at, status, mine, kind").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <div className="flex items-center justify-between px-4 pt-3 text-sm">
        <Link href="/" className="text-muted">‹ Clubs</Link>
        <Link href="/bookings" className="text-action">My bookings</Link>
      </div>
      <PlayerGrid club={club} courts={(courts ?? []) as Court[]} occ={(occ ?? []) as Occ[]} date={date} key={date} />
    </main>
  );
}
