import { notFound, redirect } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { dayBounds, todayIn } from "@/lib/time";
import { loadClubHead } from "@/lib/clubHead";
import type { Club, Court } from "@/lib/types";
import ClubHeader from "./ClubHeader";
import PlayerGrid, { type Occ } from "./PlayerGrid";

type ClubRow = Club & { booking_window_days: number; service_fee_usd: number; location_url: string | null; hold_minutes: number; town_id: string | null };

export default async function ClubPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ date?: string; at?: string; court?: string; dur?: string }> }) {
  const { slug } = await params;
  const { date: qDate, at, court, dur } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    const { data: me } = await supabase.from("profiles").select("name").eq("id", user.id).single();
    if (!me?.name) {
      const q = new URLSearchParams(); if (at) q.set("at", at); if (court) q.set("court", court); if (dur) q.set("dur", dur);
      redirect(`/profile?next=${encodeURIComponent(`/club/${slug}${q.size ? `?${q}` : ""}`)}`);
    }
  }

  const { data: club } = await supabase
    .from("clubs")
    .select("id, name, slug, timezone, slot_minutes, cancel_cutoff_hours, open_time, close_time, min_booking_minutes, max_booking_minutes, booking_window_days, service_fee_usd, location_url, hold_minutes, town_id, payment_mode")
    .eq("slug", slug).eq("active", true).single<ClubRow>();
  if (!club) notFound();

  // ?at=<ISO>&court=<id> (from Home's next-free pill) opens that day with the slot selected
  const atOk = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : null;
  const durN = dur && /^\d{1,3}$/.test(dur) ? Number(dur) : null;
  const preselect = atOk && court ? { date: formatInTimeZone(atOk, club.timezone, "yyyy-MM-dd"), time: formatInTimeZone(atOk, club.timezone, "HH:mm"), courtId: court, minutes: durN } : null;
  const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : preselect?.date ?? todayIn(club.timezone);
  const { dayStart, dayEnd } = dayBounds(date, club.timezone);

  const [{ data: courts }, { data: occ, error: occError }, { data: holdRows }, head, { data: sportRows }] = await Promise.all([
    supabase.from("courts").select("id, name, sport, surface, sort, active").eq("club_id", club.id).eq("active", true).order("sort"),
    user
      ? supabase.from("occupancy").select("id, court_id, start_at, end_at, status, mine, kind").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart)
      : supabase.from("public_occupancy").select("court_id, start_at, end_at, kind").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart),
    user ? supabase.rpc("my_active_hold") : Promise.resolve({ data: [] }),
    loadClubHead(supabase, club),
    supabase.from("sports").select("code, name_en"),
  ]);
  const hold = ((holdRows ?? []) as { booking_id: string; court_name: string; start_at: string; end_at: string; hold_expires_at: string }[])[0] ?? null;
  const sportNames = Object.fromEntries(((sportRows ?? []) as { code: string; name_en: string }[]).map((s) => [s.code, s.name_en]));

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <ClubHeader club={head} tab="" />
      <PlayerGrid signedIn={!!user} club={club} courts={(courts ?? []) as Court[]} occ={(occ ?? []) as Occ[]} occError={!!occError} date={date} hold={hold} preselect={preselect} sportNames={sportNames} />
    </main>
  );
}
