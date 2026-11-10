import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadClubHead } from "@/lib/clubHead";
import ClubHeader from "../ClubHeader";

const fmtDur = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`);

export default async function ClubInfo({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/club/${slug}/info`);
  const { data: club } = await supabase.from("clubs")
    .select("id, name, slug, open_time, close_time, location_url, town_id, slot_minutes, min_booking_minutes, max_booking_minutes, cancel_cutoff_hours, hold_minutes, booking_window_days, service_fee_usd, lat, lng")
    .eq("slug", slug).eq("active", true).single();
  if (!club) notFound();
  const [head, { data: courts }, { data: rules }] = await Promise.all([
    loadClubHead(supabase, club),
    supabase.from("courts").select("name, sport, surface").eq("club_id", club.id).eq("active", true).order("sort"),
    supabase.from("price_rules").select("start_time, end_time, price_usd, label, court_id").eq("club_id", club.id).order("start_time"),
  ]);
  const maps = club.lat != null && club.lng != null ? `https://www.google.com/maps?q=${club.lat},${club.lng}` : club.location_url;
  const row = "flex justify-between gap-4 py-2 text-sm";
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <ClubHeader club={head} tab="/info" />
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-4">
        <section className="rounded-2xl border border-grid bg-white px-4 py-2">
          <h2 className="pt-2 font-medium">Opening and booking</h2>
          <div className={row}><span className="text-muted">Open</span><span>{club.open_time.slice(0, 5)}–{club.close_time.slice(0, 5)}, every day</span></div>
          <div className={row}><span className="text-muted">Booking length</span><span>{fmtDur(club.min_booking_minutes)} to {fmtDur(club.max_booking_minutes)}, {club.slot_minutes}-min steps</span></div>
          <div className={row}><span className="text-muted">Book ahead</span><span>up to {club.booking_window_days} days</span></div>
          <div className={row}><span className="text-muted">Free cancellation</span><span>until {club.cancel_cutoff_hours} h before; no refund after</span></div>
          <div className={row}><span className="text-muted">Booking fee</span><span>${Number(club.service_fee_usd).toFixed(2)} per booking</span></div>
        </section>
        <section className="rounded-2xl border border-grid bg-white px-4 py-2">
          <h2 className="pt-2 font-medium">Courts</h2>
          {(courts ?? []).map((c) => <div key={c.name} className={row}><span>{c.name}</span><span className="text-muted">{c.sport}{c.surface ? ` · ${c.surface}` : ""}</span></div>)}
        </section>
        <section className="rounded-2xl border border-grid bg-white px-4 py-2">
          <h2 className="pt-2 font-medium">Prices per hour</h2>
          {(rules ?? []).map((r, i) => <div key={i} className={row}><span>{r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}{r.label ? ` · ${r.label}` : ""}{r.court_id ? " · one court" : ""}</span><span>${Number(r.price_usd).toFixed(0)}</span></div>)}
          {(rules ?? []).length === 0 && <p className="py-2 text-sm text-muted">Prices shown when you pick a slot.</p>}
        </section>
        {maps && <a href={maps} target="_blank" rel="noreferrer" className="rounded-2xl border border-grid bg-white px-4 py-3 text-center text-sm text-action">Open in Maps</a>}
      </div>
    </main>
  );
}
