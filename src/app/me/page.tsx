import Link from "next/link";
import { redirect } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { hhmm, nowMs } from "@/lib/time";

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

  const Item = ({ r }: { r: AgendaRow }) => {
    const [label, cls] = agendaPill(r);
    return (
      <li>
        <Link href={r.kind === "booking" ? `/bookings/${r.id}` : `/matches/${r.id}`} className="flex items-center gap-3 px-4 py-3">
          <div className="w-24 shrink-0 text-sm">
            <div className="font-medium">{formatInTimeZone(new Date(r.start_at), r.timezone, "EEE d MMM")}</div>
            <div className="text-muted">{hhmm(r.start_at, r.timezone)}{r.end_at ? `–${hhmm(r.end_at, r.timezone)}` : ""}</div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{r.title ?? (r.kind === "booking" ? "Court" : "Match")}</div>
            <div className="truncate text-sm text-muted">{r.club_name}</div>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>
        </Link>
      </li>
    );
  };

  const bookings = upcoming.filter((r) => r.kind === "booking");
  const matchesUp = upcoming.filter((r) => r.kind === "match");
  const hero = bookings[0] ?? null;
  const initialsOf = (name: string) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const Card = ({ r, extra }: { r: AgendaRow; extra?: React.ReactNode }) => (
    <Link href={r.kind === "booking" ? `/bookings/${r.id}` : `/matches/${r.id}`} className="card flex flex-col gap-2.5 p-4">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{initialsOf(r.club_name)}</span>
        <div className="min-w-0 flex-1"><div className="truncate text-base font-bold">{r.title ?? (r.kind === "booking" ? "Court" : "Match")}</div><div className="truncate text-[13px] text-muted">{r.club_name}</div></div>
        <div className="text-right"><div className="text-[15px] font-bold">{hhmm(r.start_at, r.timezone)}{r.end_at ? `–${hhmm(r.end_at, r.timezone)}` : ""}</div><div className="text-xs text-muted">{formatInTimeZone(new Date(r.start_at), r.timezone, "EEE, d MMM")}</div></div>
      </div>
      {extra}
    </Link>
  );
  const pillOf = (r: AgendaRow) => { const [label, cls] = agendaPill(r); return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>; };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5 pt-12">
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5">
        <a href="#upcoming" className="chip chip-on">Upcoming ({bookings.length})</a>
        <a href="#matches" className="chip">Matches ({matchesUp.length})</a>
        <a href="#history" className="chip">History</a>
      </div>
      {hero ? (
        <section id="upcoming" className="flex flex-col gap-3">
          <h1 className="text-[26px] font-extrabold tracking-tight">Your next booking!</h1>
          <Link href={`/bookings/${hero.id}`} className="card overflow-hidden">
            <div className="relative h-28 bg-turf" aria-hidden="true"><div className="absolute inset-[18px_24px] rounded-md border-[3px] border-white/85" /><div className="absolute bottom-[18px] left-1/2 top-[18px] w-[3px] bg-white/85" /><div className="absolute left-6 right-6 top-1/2 h-[3px] bg-white/50" /><div className="absolute right-7 top-6 h-3.5 w-3.5 rounded-full bg-cedar" /></div>
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{initialsOf(hero.club_name)}</span>
                <div className="min-w-0 flex-1"><div className="truncate text-[17px] font-bold">{hero.title ?? "Court"}</div><div className="truncate text-[13px] text-muted">{hero.club_name}</div></div>
                <div className="text-right"><div className="text-base font-bold">{hhmm(hero.start_at, hero.timezone)}{hero.end_at ? `–${hhmm(hero.end_at, hero.timezone)}` : ""}</div><div className="text-xs text-muted">{formatInTimeZone(new Date(hero.start_at), hero.timezone, "EEE, d MMM yyyy")}</div></div>
              </div>
              <div className="flex items-center gap-2 border-t border-grid pt-3 text-[13px] text-muted">{pillOf(hero)}<span>Tap for directions, share or cancel</span></div>
            </div>
          </Link>
          {bookings.length > 1 && <h2 className="pt-1 text-xl font-bold">Coming up</h2>}
          {bookings.slice(1).map((r) => <Card key={r.id} r={r} />)}
        </section>
      ) : (
        <section id="upcoming" className="card p-6 text-center text-sm text-muted">No court booked yet. <Link href="/courts" className="font-semibold text-turf">Book a court</Link></section>
      )}
      <section id="matches" className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-xl font-bold"><span className="h-2.5 w-2.5 rounded-full bg-cedar" aria-hidden="true" />Matches you&apos;re in</h2>
        {matchesUp.length === 0 && <p className="card p-5 text-center text-sm text-muted">No upcoming matches. <Link href="/play" className="font-semibold text-turf">Find a game</Link></p>}
        {matchesUp.map((r) => <Card key={r.id} r={r} extra={<div className="flex items-center gap-2 border-t border-grid pt-2.5 text-[13px] text-muted">{pillOf(r)}<span>Open for chat and details</span></div>} />)}
      </section>
      {past.length > 0 && (
        <section id="history" className="flex flex-col gap-3">
          <h2 className="text-xl font-bold">History</h2>
          <ul className="card divide-y divide-grid overflow-hidden">{past.slice(0, 50).map((r) => <Item key={r.kind + r.id} r={r} />)}</ul>
        </section>
      )}
    </main>
  );
}
