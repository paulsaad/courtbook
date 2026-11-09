import Link from "next/link";
import { redirect } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { hhmm, nowMs } from "@/lib/time";

type Row = {
  id: string; status: string; start_at: string; end_at: string; price_usd: number | null; fee_usd: number | null;
  clubs: { name: string; slug: string; timezone: string } | null; courts: { name: string } | null;
};

export default async function MyBookings() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/bookings");

  const { data } = await supabase
    .from("bookings")
    .select("id, status, start_at, end_at, price_usd, fee_usd, clubs(name, slug, timezone), courts(name)")
    .eq("player_id", user.id)
    .in("status", ["confirmed", "cancelled", "no_show"])
    .order("start_at", { ascending: false })
    .limit(100);
  const rows = (data ?? []) as unknown as Row[];
  const now = nowMs();
  const upcoming = rows.filter((r) => r.status === "confirmed" && new Date(r.end_at).getTime() > now).sort((a, b) => a.start_at.localeCompare(b.start_at));
  const past = rows.filter((r) => !(r.status === "confirmed" && new Date(r.end_at).getTime() > now));

  const Item = ({ r }: { r: Row }) => {
    const tz = r.clubs?.timezone ?? "Asia/Beirut";
    return (
      <li>
        <Link href={`/bookings/${r.id}`} className="flex items-center gap-3 px-4 py-3">
          <div className="w-24 shrink-0 text-sm">
            <div className="font-medium">{formatInTimeZone(new Date(r.start_at), tz, "EEE d MMM")}</div>
            <div className="text-muted">{hhmm(r.start_at, tz)}–{hhmm(r.end_at, tz)}</div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{r.clubs?.name}</div>
            <div className="text-sm text-muted">{r.courts?.name}</div>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-xs ${r.status === "confirmed" ? "bg-turf-soft text-turf" : "bg-slate-soft text-muted"}`}>
            {r.status === "confirmed" ? "confirmed" : r.status === "no_show" ? "no-show" : "cancelled"}
          </span>
        </Link>
      </li>
    );
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
      <Link href="/" className="text-sm text-muted">‹ Clubs</Link>
      <h1 className="text-2xl font-semibold tracking-tight">My bookings</h1>
      <section>
        <h2 className="mb-2 text-sm font-medium text-muted">Upcoming</h2>
        <ul className="divide-y divide-grid rounded-2xl border border-grid bg-white">
          {upcoming.length === 0 && <li className="p-6 text-center text-sm text-muted">Nothing booked yet. <Link href="/" className="text-action underline">Find a court</Link></li>}
          {upcoming.map((r) => <Item key={r.id} r={r} />)}
        </ul>
      </section>
      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-muted">Past</h2>
          <ul className="divide-y divide-grid rounded-2xl border border-grid bg-white">{past.map((r) => <Item key={r.id} r={r} />)}</ul>
        </section>
      )}
    </main>
  );
}
