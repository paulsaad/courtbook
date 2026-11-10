import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { loadRefData } from "@/lib/geo";
import { nowMs } from "@/lib/time";
import InstallHint from "@/components/InstallHint";
import Discover, { type ClubCard, type OpenMatch } from "@/components/Discover";
import type { AgendaRow } from "@/app/me/page";

const TZ = "Asia/Beirut";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    const [ref, { data: clubs, error: clubsError }] = await Promise.all([loadRefData(supabase), supabase.rpc("club_discovery")]);
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">CourtBook</h1>
          <Link href="/login" className="rounded-full bg-action px-4 py-2 text-sm font-medium text-white">Sign in</Link>
        </header>
        <p className="text-sm text-muted">Book sports courts, find players and coaches across Lebanon. Browse freely; sign in when you reserve.</p>
        <InstallHint />
        <Discover areas={ref.areas} sports={ref.sports} initialClubs={(clubs ?? []) as ClubCard[]} initialMatches={[]} signedIn={false} initialError={!!clubsError} />
      </main>
    );
  }

  const [{ data: me }, ref, { data: clubs, error: clubsError }, { data: matches }, { data: agenda }] = await Promise.all([
    supabase.from("profiles").select("name").eq("id", user.id).single(),
    loadRefData(supabase),
    supabase.rpc("club_discovery"),
    supabase.rpc("open_matches", { p_limit: 3 }),
    supabase.rpc("my_agenda"),
  ]);
  const firstName = me?.name?.split(" ")[0];
  const now = nowMs();
  const nx = ((agenda ?? []) as AgendaRow[])
    .filter((r) => r.status !== "cancelled" && r.status !== "no_show" && new Date(r.end_at ?? r.start_at).getTime() > now)
    .sort((a, b) => a.start_at.localeCompare(b.start_at))[0] ?? null;
  const next = nx ? {
    href: nx.kind === "booking" ? `/bookings/${nx.id}` : `/matches/${nx.id}`, when: nx.start_at,
    title: `${nx.title ?? ""} · ${nx.club_name}`,
    kind: nx.kind === "booking" ? "Your booking" : nx.role === "organizer" ? "Your match" : nx.role === "pending" ? "Requested" : "You're playing",
  } : null;

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
      <Discover areas={ref.areas} sports={ref.sports} initialClubs={(clubs ?? []) as ClubCard[]} initialMatches={(matches ?? []) as OpenMatch[]} signedIn initialError={!!clubsError} />
    </main>
  );
}
