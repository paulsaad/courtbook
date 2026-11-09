import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { hhmm, nowMs } from "@/lib/time";
import CancelButton from "./CancelButton";

export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string }> }) {
  const { id } = await params;
  const { new: isNew } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: b } = await supabase
    .from("bookings")
    .select("id, status, start_at, end_at, price_usd, fee_usd, cancelled_at, clubs(name, slug, timezone, cancel_cutoff_hours, location_url), courts!bookings_court_id_fkey(name, sport)")
    .eq("id", id)
    .eq("player_id", user.id)
    .single();
  if (!b) notFound();
  if (b.status === "pending") redirect(`/pay/${id}`);

  const { data: pay } = await supabase.from("payments").select("status, total_usd").eq("booking_id", id).maybeSingle();
  const club = b.clubs as unknown as { name: string; slug: string; timezone: string; cancel_cutoff_hours: number; location_url: string | null };
  const court = b.courts as unknown as { name: string; sport: string };
  const tz = club.timezone;
  const day = formatInTimeZone(new Date(b.start_at), tz, "EEEE d MMMM");
  const time = `${hhmm(b.start_at, tz)}–${hhmm(b.end_at, tz)}`;
  const cutoffAt = new Date(new Date(b.start_at).getTime() - club.cancel_cutoff_hours * 3600_000);
  const freeCancel = b.status === "confirmed" && cutoffAt.getTime() > nowMs();
  const upcoming = b.status === "confirmed" && new Date(b.end_at).getTime() > nowMs();

  const waText = encodeURIComponent(`Court booked ✅ ${club.name}, ${court.name}\n${day}, ${time}\n${club.location_url ?? ""}`.trim());

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
      <Link href="/bookings" className="text-sm text-muted">‹ My bookings</Link>
      <div>
        {isNew && b.status === "confirmed" && <p className="mb-2 inline-block rounded-full bg-turf-soft px-3 py-1 text-sm font-medium text-turf">Booked</p>}
        <h1 className="text-2xl font-semibold tracking-tight">{club.name}</h1>
        <p className="mt-1 text-lg">{court.name} · {day}</p>
        <p className="text-lg">{time}</p>
        {b.status !== "confirmed" && <p className="mt-2 text-sm text-muted">Status: {b.status === "no_show" ? "no-show" : b.status}</p>}
      </div>

      <div className="rounded-2xl border border-grid bg-white p-4 text-sm">
        <div className="flex justify-between py-1"><span>Court</span><span>${Number(b.price_usd ?? 0).toFixed(2)}</span></div>
        <div className="flex justify-between py-1"><span>Booking fee</span><span>${Number(b.fee_usd ?? 0).toFixed(2)}</span></div>
        <div className="mt-2 flex justify-between border-t border-grid pt-3 font-semibold"><span>Paid</span><span>${Number(pay?.total_usd ?? 0).toFixed(2)}</span></div>
        {pay?.status === "refund_due" && <p className="mt-2 text-muted">Refund on its way.</p>}
        {pay?.status === "refunded" && <p className="mt-2 text-muted">Refunded.</p>}
      </div>

      {upcoming && (
        <>
          <a href={`https://wa.me/?text=${waText}`} target="_blank" rel="noreferrer" className="rounded-xl bg-[#25D366] py-3.5 text-center font-medium text-white">Share on WhatsApp</a>
          {club.location_url && <a href={club.location_url} target="_blank" rel="noreferrer" className="rounded-xl border border-grid bg-white py-3.5 text-center">Directions</a>}
          <CancelButton bookingId={b.id} freeCancel={freeCancel} cutoffHours={club.cancel_cutoff_hours} cutoffLabel={`${formatInTimeZone(cutoffAt, tz, "EEE d MMM HH:mm")}`} />
        </>
      )}
    </main>
  );
}
