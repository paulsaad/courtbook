import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { loadRefData } from "@/lib/geo";
import { nowMs } from "@/lib/time";
import InstallHint from "@/components/InstallHint";
import HomeClient from "@/components/HomeClient";
import { Cedar } from "@/components/Brand";
import { IconBell } from "@/components/Icons";
import type { OpenMatch } from "@/components/Discover";
import type { AgendaRow } from "@/lib/agenda";

const TZ = "Asia/Beirut";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const ref = await loadRefData(supabase);

  if (!user) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5 pt-12">
        <header className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-[30px] font-extrabold tracking-tight"><Cedar size={24} />CourtBook</h1>
          <Link href="/login" className="rounded-full bg-turf px-4 py-2 text-sm font-semibold text-white">Sign in</Link>
        </header>
        <p className="text-sm text-muted">Courts, games and coaches across Lebanon. Browse freely; sign in when you reserve.</p>
        <InstallHint />
        <HomeClient areas={ref.areas} sports={ref.sports} initialMatches={[]} signedIn={false} />
      </main>
    );
  }

  const [{ data: me }, { data: matches }, { data: agenda }, { count: unread }] = await Promise.all([
    supabase.from("profiles").select("name").eq("id", user.id).single(),
    supabase.rpc("open_matches", { p_limit: 6 }),
    supabase.rpc("my_agenda"),
    supabase.from("notifications").select("*", { count: "exact", head: true }).eq("profile_id", user.id).is("read_at", null),
  ]);
  const firstName = me?.name?.split(" ")[0];
  const now = nowMs();
  const nx = ((agenda ?? []) as AgendaRow[])
    .filter((r) => r.status !== "cancelled" && r.status !== "no_show" && new Date(r.end_at ?? r.start_at).getTime() > now)
    .sort((a, b) => a.start_at.localeCompare(b.start_at))[0] ?? null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-3.5 p-5 pt-10">
      <header className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-[28px] font-extrabold tracking-tight"><Cedar size={24} />{firstName ? `Hello ${firstName}` : "CourtBook"}</h1>
        <Link href="/notifications" aria-label="Activity" className="relative flex h-11 w-11 items-center justify-center rounded-full border border-grid bg-white">
          <IconBell size={24} />
          {(unread ?? 0) > 0 && <span className="absolute right-1.5 top-1.5 min-w-[18px] rounded-full bg-cedar px-1 text-center text-[11px] font-bold leading-[18px] text-white">{unread}</span>}
        </Link>
      </header>
      <InstallHint />
      {nx && (
        <section className="flex flex-col gap-2.5">
          <h2 className="text-xl font-bold">Your next game</h2>
          <Link href={nx.kind === "booking" ? `/bookings/${nx.id}` : `/matches/${nx.id}`} className="card flex flex-col gap-2.5 p-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{nx.club_name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="text-base font-bold leading-tight">{nx.title ?? (nx.kind === "booking" ? "Court" : "Match")}</div>
                <div className="text-[13px] text-muted">{nx.club_name}</div>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-grid pt-2.5 text-[15px]">
              <span className="font-semibold">{formatInTimeZone(new Date(nx.start_at), nx.timezone ?? TZ, "EEE d MMM")} · {formatInTimeZone(new Date(nx.start_at), nx.timezone ?? TZ, "HH:mm")}{nx.end_at ? `–${formatInTimeZone(new Date(nx.end_at), nx.timezone ?? TZ, "HH:mm")}` : ""}</span>
              <span className="rounded-full bg-turf-soft px-2 py-0.5 text-xs text-turf">{nx.kind === "booking" ? "booked" : nx.role === "organizer" ? "your match" : nx.role === "pending" ? "requested" : "you're in"}</span>
            </div>
          </Link>
        </section>
      )}
      <HomeClient areas={ref.areas} sports={ref.sports} initialMatches={(matches ?? []) as OpenMatch[]} signedIn />
    </main>
  );
}
