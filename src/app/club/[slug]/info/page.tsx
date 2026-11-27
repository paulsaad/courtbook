import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { allLoaded, loaded } from "@/lib/load";
import { loadClubHead } from "@/lib/clubHead";
import { directionsUrl } from "@/lib/places";
import ClubHeader from "../ClubHeader";
import { FACILITIES } from "@/components/facilities";
import { feeSummary } from "@/lib/fees";
import { cancellationLine } from "./cancellation";
import { codeLabel } from "@/lib/labels";

const fmtDur = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`);

export default async function ClubInfo({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();   // only decides whether the heart offers sign-in
  const { data: club } = loaded(await supabase.from("clubs")
    .select("id, name, slug, open_time, close_time, location_url, town_id, slot_minutes, min_booking_minutes, max_booking_minutes, cancel_cutoff_hours, hold_minutes, booking_window_days, service_fee_usd, payment_mode, lat, lng, description, arrival_notes, address, has_parking, has_changing_rooms, has_showers, has_equipment_rental, has_cafe, has_floodlights, has_drinking_water, is_demo")
    .eq("slug", slug).eq("active", true).single(), "this club");
  if (!club) notFound();
  const [head, { data: courts }, { data: rules }] = allLoaded(await Promise.all([
    loadClubHead(supabase, club),
    supabase.from("courts").select("name, sport, surface").eq("club_id", club.id).eq("active", true).order("sort"),
    supabase.from("price_rules").select("start_time, end_time, price_usd, label, court_id").eq("club_id", club.id).order("start_time"),
  ]), "this club");
  // 0081: the club's phone and email; read on their own so this page keeps working before the columns exist
  const contactRes = await supabase.from("clubs").select("contact_phone, contact_email").eq("id", club.id).single();
  const contact = contactRes.error && /contact_(phone|email)|42703/.test(`${contactRes.error.code} ${contactRes.error.message}`)
    ? null : (loaded(contactRes, "this club").data as { contact_phone: string | null; contact_email: string | null } | null);
  const maps = directionsUrl(club.lat, club.lng, club.location_url);
  const row = "flex justify-between gap-4 py-2 text-sm";
  // A club that takes payment at its desk charges no booking fee; the page must not promise one.
  const fees = feeSummary(club.payment_mode, club.service_fee_usd);
  const cancel = cancellationLine(club.payment_mode, club.cancel_cutoff_hours);
  // Three states, and only two of them are worth a player's attention. A facility nobody has
  // answered is left out entirely — showing it as a no would be inventing an answer the club
  // never gave, and showing it as "unknown" is a row of noise on a small screen.
  const facilities = FACILITIES
    .map(([key, label]) => [label, (club as Record<string, unknown>)[key] as boolean | null] as const)
    .filter(([, value]) => value !== null);
  const has = facilities.filter(([, v]) => v === true);
  const hasNot = facilities.filter(([, v]) => v === false);
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <ClubHeader club={head} tab="/info" signedIn={!!user} />
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-4">
        {club.description && (
          <section className="rounded-2xl border border-grid bg-white px-4 py-3">
            <h2 className="font-medium">About</h2>
            <p className="mt-1 whitespace-pre-line text-sm text-muted">{club.description}</p>
          </section>
        )}
        {(contact?.contact_phone || contact?.contact_email) && (
          <section className="rounded-2xl border border-grid bg-white px-4 py-3">
            <h2 className="font-medium">Contact the club</h2>
            {contact.contact_phone && <p className="mt-1 text-sm"><a className="text-action underline" href={`tel:${contact.contact_phone.replace(/[^0-9+]/g, "")}`}>{contact.contact_phone}</a></p>}
            {contact.contact_email && <p className="mt-1 text-sm"><a className="text-action underline" href={`mailto:${contact.contact_email}`}>{contact.contact_email}</a></p>}
          </section>
        )}
        {(club.address || club.arrival_notes) && (
          <section className="rounded-2xl border border-grid bg-white px-4 py-3">
            <h2 className="font-medium">Getting there</h2>
            {club.address && <p className="mt-1 text-sm">{club.address}</p>}
            {club.arrival_notes && <p className="mt-1 whitespace-pre-line text-sm text-muted">{club.arrival_notes}</p>}
          </section>
        )}
        {facilities.length > 0 && (
          <section className="rounded-2xl border border-grid bg-white px-4 py-3">
            <h2 className="font-medium">Facilities</h2>
            {has.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {has.map(([label]) => (
                  <li key={label} className="rounded-full bg-turf-soft px-3 py-1 text-xs text-turf">{label}</li>
                ))}
              </ul>
            )}
            {hasNot.length > 0 && (
              <p className="mt-2 text-xs text-muted">No {hasNot.map(([label]) => label.toLowerCase()).join(", ")}.</p>
            )}
          </section>
        )}
        <section className="rounded-2xl border border-grid bg-white px-4 py-2">
          <h2 className="pt-2 font-medium">Opening and booking</h2>
          <div className={row}><span className="text-muted">Open</span><span>{club.open_time.slice(0, 5)}–{club.close_time.slice(0, 5)}, every day</span></div>
          <div className={row}><span className="text-muted">Booking length</span><span>{fmtDur(club.min_booking_minutes)} to {fmtDur(club.max_booking_minutes)}, {club.slot_minutes}-min steps</span></div>
          <div className={row}><span className="text-muted">Book ahead</span><span>up to {club.booking_window_days} days</span></div>
          <div className={row}><span className="text-muted">{cancel.label}</span><span>{cancel.text}</span></div>
          <div className={row}><span className="text-muted">Booking fee</span><span>{fees.fee}</span></div>
          {fees.payment && <div className={row}><span className="text-muted">Payment</span><span className="text-right">{fees.payment}</span></div>}
        </section>
        <section className="rounded-2xl border border-grid bg-white px-4 py-2">
          <h2 className="pt-2 font-medium">Courts</h2>
          {(courts ?? []).map((c) => <div key={c.name} className={row}><span>{c.name}</span><span className="text-muted">{codeLabel(c.sport)}{c.surface ? ` · ${c.surface}` : ""}</span></div>)}
        </section>
        <section className="rounded-2xl border border-grid bg-white px-4 py-2">
          <h2 className="pt-2 font-medium">Prices per hour</h2>
          {(rules ?? []).map((r, i) => <div key={i} className={row}><span>{r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}{r.label ? ` · ${r.label}` : ""}{r.court_id ? " · one court" : ""}</span><span>${Number(r.price_usd).toFixed(0)}</span></div>)}
          {(rules ?? []).length === 0 && <p className="py-2 text-sm text-muted">Prices shown when you pick a slot.</p>}
        </section>
        {maps && <a href={maps} target="_blank" rel="noreferrer" className="rounded-2xl border border-grid bg-white px-4 py-3 text-center text-sm text-action">Directions</a>}
      </div>
    </main>
  );
}
