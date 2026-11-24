import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { dayBounds, todayIn } from "@/lib/time";
import { loaded } from "@/lib/load";
import { STAFF_BOOKING_COLUMNS, type Block, type Booking, type Club, type Court } from "@/lib/types";
import DayCalendar from "./DayCalendar";
import WorkNav from "@/components/WorkNav";

export default async function StaffClubPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string; view?: string; sport?: string; court?: string; time?: string }>;
}) {
  const { slug } = await params;
  const { date: qDate, view, sport, court, time } = await searchParams;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: club } = loaded(await supabase
    .from("clubs")
    .select("id, name, slug, timezone, slot_minutes, cancel_cutoff_hours, open_time, close_time, min_booking_minutes, max_booking_minutes")
    .eq("slug", slug)
    .single<Club>(), "the calendar");
  if (!club) notFound();

  // Staff check (RLS enforces anyway; this is for a clear message instead of empty data)
  const { data: profile } = loaded(await supabase.from("profiles").select("roles").eq("id", user.id).single(), "the calendar");
  const isAdmin = profile?.roles?.includes("admin") ?? false;
  const { count } = loaded(await supabase
    .from("club_staff")
    .select("*", { count: "exact", head: true })
    .eq("club_id", club.id)
    .eq("profile_id", user.id), "the calendar");
  if (!isAdmin && !count) {
    return (
      <main className="mx-auto max-w-md p-6 md:max-w-2xl lg:max-w-[720px]">
        <p>You are not staff at {club.name}.</p>
        <Link href="/" className="underline">Home</Link>
      </main>
    );
  }

  const date = qDate && /^\d{4}-\d{2}-\d{2}$/.test(qDate) ? qDate : todayIn(club.timezone);
  const { dayStart, dayEnd } = dayBounds(date, club.timezone);

  // the day's bookings and blocks keep DayCalendar's own "couldn't load" state (loadFailed); courts and sports must succeed
  const [courtsRes, { data: bookings, error: bookingsError }, { data: blocks, error: blocksError }, sportRes] = await Promise.all([
    supabase.from("courts").select("id, name, sport, surface, sort, active").eq("club_id", club.id).eq("active", true).order("sort"),
    supabase
      .from("bookings")
      .select(STAFF_BOOKING_COLUMNS)
      .eq("club_id", club.id)
      .or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`)
      .not("court_id", "is", null)
      .lt("start_at", dayEnd)
      .gt("end_at", dayStart)
      .order("start_at"),
    supabase
      .from("blocks")
      .select("id, court_id, start_at, end_at, reason")
      .eq("club_id", club.id)
      .lt("start_at", dayEnd)
      .gt("end_at", dayStart),
    supabase.from("sports").select("code, name_en"),
  ]);
  const { data: courts } = loaded(courtsRes, "the calendar");
  const { data: sportRows } = loaded(sportRes, "the calendar");
  const sportNames = Object.fromEntries(((sportRows ?? []) as { code: string; name_en: string }[]).map((s) => [s.code, s.name_en]));

  // Who booked, and how the desk reaches them. Staff-only, scoped to this club's own bookings.
  const ids = (bookings ?? []).map((b) => b.id);
  const contacts = new Map<string, { name: string | null; phone: string | null }>();
  if (ids.length) {
    const { data } = loaded(await supabase.rpc("club_booking_contacts", { p_club: club.id, p_bookings: ids }), "the calendar");
    (data as { booking_id: string; name: string | null; phone: string | null }[] | null)
      ?.forEach((c) => contacts.set(c.booking_id, { name: c.name, phone: c.phone }));
  }
  const bookingsWithNames: Booking[] = (bookings ?? []).map((b) => ({
    ...b,
    player_name: contacts.get(b.id)?.name ?? null,
    contact_phone: contacts.get(b.id)?.phone ?? null,
  }));

  return (
    <>
    <WorkNav area="staff" slug={club.slug} clubName={club.name} active="calendar" />
    <DayCalendar
      key={date}
      club={club}
      courts={(courts ?? []) as Court[]}
      bookings={bookingsWithNames}
      blocks={(blocks ?? []) as Block[]}
      date={date}
      view={view === "list" ? "list" : view === "week" ? "week" : view === "grid" ? "grid" : date === todayIn(club.timezone) ? "now" : "grid"}
      court={court ?? null}
      loadFailed={Boolean(bookingsError || blocksError)}
      sport={sport && /^[a-z_]+$/.test(sport) ? sport : null}
      sportNames={sportNames}
      explicit={Boolean(view || sport)}
      focusTime={time && /^\d{2}:\d{2}$/.test(time) ? time : null}
    />
    </>
  );
}
