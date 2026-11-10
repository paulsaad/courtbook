import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { loadRefData } from "@/lib/geo";
import InstallHint from "@/components/InstallHint";
import Discover, { type ClubCard, type OpenMatch } from "@/components/Discover";

const TZ = "Asia/Beirut";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const [ref, { data: clubs }] = await Promise.all([loadRefData(supabase), supabase.rpc("club_discovery")]);
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">CourtBook</h1>
          <Link href="/login" className="rounded-full bg-action px-4 py-2 text-sm font-medium text-white">Sign in</Link>
        </header>
        <p className="text-sm text-muted">Book sports courts, find players and coaches across Lebanon. Browse freely; sign in when you reserve.</p>
        <InstallHint />
        <Discover areas={ref.areas} sports={ref.sports} initialClubs={(clubs ?? []) as ClubCard[]} initialMatches={[]} signedIn={false} />
      </main>
    );
  }

  const [{ data: me }, ref, { data: clubs }, { data: matches }, { data: nextBooking }, { data: myMatches }] = await Promise.all([
    supabase.from("profiles").select("name").eq("id", user.id).single(),
    loadRefData(supabase),
    supabase.rpc("club_discovery"),
    supabase.rpc("open_matches", { p_limit: 3 }),
    supabase.from("bookings").select("id, start_at, end_at, clubs(name, slug), courts!bookings_court_id_fkey(name)").eq("player_id", user.id).eq("status", "confirmed").gt("end_at", new Date().toISOString()).order("start_at").limit(1),
    supabase.rpc("match_board", { p_club: null, p_days: 14 }),
  ]);
  const firstName = me?.name?.split(" ")[0];
  const nb = (nextBooking as unknown as { id: string; start_at: string; end_at: string; clubs: { name: string; slug: string } | null; courts: { name: string } | null }[] | null)?.[0] ?? null;
  const nm = ((myMatches ?? []) as { match_id: string; start_at: string; club_name: string; sport: string; i_joined: boolean; i_organize: boolean; status: string }[])
    .filter((m) => (m.i_joined || m.i_organize) && m.status !== "cancelled")[0] ?? null;
  const next = nb && (!nm || nb.start_at <= nm.start_at)
    ? { href: `/bookings/${nb.id}`, when: nb.start_at, title: `${nb.clubs?.name} · ${nb.courts?.name}`, kind: "Your booking" }
    : nm ? { href: `/matches/${nm.match_id}`, when: nm.start_at, title: `${nm.sport} match · ${nm.club_name}`, kind: nm.i_organize ? "Your match" : "You're playing" } : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{firstName ? `Hi ${firstName}` : "CourtBook"}</h1>
        <Link href="/notifications" className="text-sm text-muted">Activity</Link>
      </header>
      <InstallHint />
      {next && (
        <Link href={next.href} className="flex items-center gap-4 rounded-2xl bg-ink p-4 text-white active:opacity-90">
          <div className="text-center">
            <div className="text-xs uppercase tracking-wide opacity-70">{formatInTimeZone(new Date(next.when), TZ, "EEE")}</div>
            <div className="text-2xl font-semibold leading-none">{formatInTimeZone(new Date(next.when), TZ, "d")}</div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs opacity-70">{next.kind} · {formatInTimeZone(new Date(next.when), TZ, "HH:mm")}</div>
            <div className="truncate font-medium">{next.title}</div>
          </div>
          <span className="opacity-70">›</span>
        </Link>
      )}
      <Discover areas={ref.areas} sports={ref.sports} initialClubs={(clubs ?? []) as ClubCard[]} initialMatches={(matches ?? []) as OpenMatch[]} signedIn />
    </main>
  );
}
