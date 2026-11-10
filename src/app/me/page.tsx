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

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
      <h1 className="text-2xl font-semibold tracking-tight">My CourtBook</h1>
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted">Upcoming</h2>
        <ul className="divide-y divide-grid rounded-2xl border border-grid bg-white">
          {upcoming.length === 0 && <li className="p-6 text-center text-sm text-muted">Nothing planned. <Link href="/" className="text-action underline">Book a court</Link> or <Link href="/play" className="text-action underline">find a game</Link>.</li>}
          {upcoming.map((r) => <Item key={r.kind + r.id} r={r} />)}
        </ul>
      </section>
      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-muted">Past</h2>
          <ul className="divide-y divide-grid rounded-2xl border border-grid bg-white">{past.slice(0, 50).map((r) => <Item key={r.kind + r.id} r={r} />)}</ul>
        </section>
      )}
    </main>
  );
}
