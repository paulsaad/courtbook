import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatInTimeZone } from "date-fns-tz";
import { dayBounds, todayIn } from "@/lib/time";
import type { Club, Court } from "@/lib/types";
import PlayerGrid, { type Occ } from "./PlayerGrid";

export default async function ClubPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string; at?: string }>;
}) {
  const { slug } = await params;
  const { date: qDate0, at } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/club/${slug}`);
  const { data: me } = await supabase.from("profiles").select("name").eq("id", user.id).single();
  if (!me?.name) redirect(`/profile?next=/club/${slug}`);

  const { data: club } = await supabase
    .from("clubs")
    .select("id, name, slug, timezone, slot_minutes, cancel_cutoff_hours, open_time, close_time, min_booking_minutes, max_booking_minutes, booking_window_days, service_fee_usd, location_url, hold_minutes")
    .eq("slug", slug)
    .eq("active", true)
    .single<Club & { booking_window_days: number; service_fee_usd: number; location_url: string | null; hold_minutes: number }>();
  if (!club) notFound();

  const atDate = at && !Number.isNaN(Date.parse(at)) ? formatInTimeZone(new Date(at), club.timezone, "yyyy-MM-dd") : null;
  const qDate = qDate0 ?? atDate ?? undefined;
  const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : todayIn(club.timezone);
  const { dayStart, dayEnd } = dayBounds(date, club.timezone);

  const [{ data: courts }, { data: occ }, { data: holdRows }] = await Promise.all([
    supabase.from("courts").select("id, name, sport, surface, sort, active").eq("club_id", club.id).eq("active", true).order("sort"),
    supabase.from("occupancy").select("id, court_id, start_at, end_at, status, mine, kind").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart),
    supabase.rpc("my_active_hold"),
  ]);
  const hold = ((holdRows ?? []) as { booking_id: string; court_name: string; start_at: string; end_at: string; hold_expires_at: string }[])[0] ?? null;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <div className="flex items-center justify-between px-4 pt-3 text-sm">
        <Link href="/" className="text-muted">‹ Clubs</Link>
        <div className="flex gap-4"><Link href={`/club/${slug}/matches`} className="text-action">Find players</Link><Link href={`/club/${slug}/coaches`} className="text-action">Coaches</Link></div>
      </div>
      <PlayerGrid club={club} courts={(courts ?? []) as Court[]} occ={(occ ?? []) as Occ[]} date={date} hold={hold} key={date} />
    </main>
  );
}
