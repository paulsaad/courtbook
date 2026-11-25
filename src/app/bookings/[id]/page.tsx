import Link from "next/link";
import { directionsUrl } from "@/lib/places";
import { notFound, redirect } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { allLoaded, loaded } from "@/lib/load";
import { hhmm, nowMs } from "@/lib/time";
import CancelButton from "./CancelButton";
import { clubPhoneFrom } from "@/lib/clubContactPhone";
import OpenToPlayers, { type BookingMatch } from "./OpenToPlayers";

export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ new?: string }> }) {
  const { id } = await params;
  const { new: isNew } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: b } = loaded(await supabase
    .from("bookings")
    .select("id, club_id, status, start_at, end_at, price_usd, fee_usd, cancelled_at, clubs(name, slug, timezone, cancel_cutoff_hours, location_url, payment_mode, lat, lng), courts!bookings_court_id_fkey(name, sport)")
    .eq("id", id)
    .eq("player_id", user.id)
    .single(), "this booking");
  if (!b) notFound();
  if (b.status === "pending") redirect(`/pay/${id}`);

  const [{ data: pay }, { data: bm }, { data: sportRows }] = allLoaded(await Promise.all([
    supabase.from("payments").select("status, total_usd, kind").eq("booking_id", id).maybeSingle(),
    supabase.rpc("booking_match", { p_booking: id }),
    supabase.from("sports").select("code, name_en"),
  ]), "this booking");
  const match = ((bm ?? []) as NonNullable<BookingMatch>[])[0] ?? null;
  const sportLabel = new Map(((sportRows ?? []) as { code: string; name_en: string }[]).map((x) => [x.code, x.name_en]));
  const club = b.clubs as unknown as { name: string; slug: string; timezone: string; cancel_cutoff_hours: number; location_url: string | null; payment_mode: string | null; lat: number | string | null; lng: number | string | null };
  const directions = directionsUrl(club.lat, club.lng, club.location_url);
  // What was paid through CourtBook decides the wording, not the club's mode today (it may have changed since):
  //   no payment row — desk booking, pay-at-the-desk club or a $0 fee: everything is paid at the club;
  //   fee_only — the court is paid at the club, only the booking fee was paid online (M12.1).
  const atDesk = !pay;
  const feeOnly = pay?.kind === "fee_only";
  const court = b.courts as unknown as { name: string; sport: string };
  const tz = club.timezone;
  const day = formatInTimeZone(new Date(b.start_at), tz, "EEEE d MMMM");
  const time = `${hhmm(b.start_at, tz)}–${hhmm(b.end_at, tz)}`;
  const cutoffAt = new Date(new Date(b.start_at).getTime() - club.cancel_cutoff_hours * 3600_000);
  const freeCancel = b.status === "confirmed" && cutoffAt.getTime() > nowMs();
  const upcoming = b.status === "confirmed" && new Date(b.end_at).getTime() > nowMs();

  // PR-9b: when the cancellation notice asks the player to tell the club, a way to: the club's own public contact
  // phone (clubs.contact_phone; never a staff member's number). Read only then; no number or a failed read → Info link.
  const tellClub = upcoming && atDesk && !freeCancel;
  const clubPhone = tellClub ? clubPhoneFrom(await supabase.from("clubs").select("contact_phone").eq("id", b.club_id).maybeSingle()) : null;

  const waText = encodeURIComponent(`Court booked ✅ ${club.name}, ${court.name}\n${day}, ${time}\n${directions ?? ""}`.trim());

  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-5 p-5">
      <Link href="/me" className="text-sm text-muted">‹ My CourtBook</Link>
      <div>
        {isNew && b.status === "confirmed" && <p className="mb-2 inline-block rounded-full bg-turf-soft px-3 py-1 text-sm font-medium text-turf">{atDesk || feeOnly ? `Reservation confirmed · Pay $${Number(b.price_usd ?? 0).toFixed(2)} at the club` : "Booked"}</p>}
        <h1 className="text-2xl font-semibold tracking-tight">{club.name}</h1>
        <p className="mt-1 text-lg">{court.name} · {day}</p>
        <p className="text-lg">{time}</p>
        {b.status !== "confirmed" && <p className="mt-2 text-sm text-muted">Status: {b.status === "no_show" ? "no-show" : b.status}</p>}
      </div>

      <div className="rounded-2xl border border-grid bg-white p-4 text-sm">
        <div className="flex justify-between py-1"><span>Court</span><span>${Number(b.price_usd ?? 0).toFixed(2)}</span></div>
        {atDesk ? (
          <div className="mt-2 flex justify-between border-t border-grid pt-3 font-semibold"><span>Pay at the club</span><span>${Number(b.price_usd ?? 0).toFixed(2)}</span></div>
        ) : feeOnly ? (
          <>
            <div className="flex justify-between py-1"><span>Booking fee, paid online</span><span>${Number(b.fee_usd ?? 0).toFixed(2)}</span></div>
            <div className="mt-2 flex justify-between border-t border-grid pt-3 font-semibold"><span>Pay at the club</span><span>${Number(b.price_usd ?? 0).toFixed(2)}</span></div>
            <p className="mt-2 text-xs text-muted">
              {pay?.status === "refund_due" ? "The booking fee is being refunded." : pay?.status === "refunded" ? "The booking fee was refunded."
                : `The court is paid to ${club.name} when you arrive. The booking fee is not refunded if you cancel; it is refunded if the club cancels.`}
            </p>
          </>
        ) : (
          <>
            <div className="flex justify-between py-1"><span>Booking fee</span><span>${Number(b.fee_usd ?? 0).toFixed(2)}</span></div>
            <div className="mt-2 flex justify-between border-t border-grid pt-3 font-semibold"><span>Paid</span><span>${Number(pay?.total_usd ?? 0).toFixed(2)}</span></div>
            {pay?.status === "refund_due" && <p className="mt-2 text-muted">Refund on its way.</p>}
            {pay?.status === "refunded" && <p className="mt-2 text-muted">Refunded.</p>}
          </>
        )}
        {atDesk && <p className="mt-2 text-xs text-muted">Nothing is paid through CourtBook. Settle with {club.name} when you arrive.</p>}
      </div>

      {upcoming && <OpenToPlayers bookingId={b.id} sport={court.sport} sportName={sportLabel.get(court.sport) ?? court.sport} match={match} />}

      {upcoming && (
        <>
          <a href={`https://wa.me/?text=${waText}`} target="_blank" rel="noreferrer" className="rounded-xl bg-[#25D366] py-3.5 text-center font-medium text-white">Share on WhatsApp</a>
          {directions && <a href={directions} target="_blank" rel="noreferrer" className="rounded-xl border border-grid bg-white py-3.5 text-center">Directions</a>}
          <CancelButton bookingId={b.id} freeCancel={freeCancel} cutoffHours={club.cancel_cutoff_hours} cutoffLabel={`${formatInTimeZone(cutoffAt, tz, "EEE d MMM HH:mm")}`} nothingPaid={atDesk}
            keptFee={feeOnly ? Number(b.fee_usd ?? 0) : undefined} clubPhone={clubPhone} clubInfoHref={`/club/${club.slug}/info`} />
        </>
      )}
    </main>
  );
}
