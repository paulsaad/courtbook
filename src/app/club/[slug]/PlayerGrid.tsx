"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { clubLocalToUtc, shiftDate, slotTimes, todayIn, toMin } from "@/lib/time";
import { friendlyError, type Club, type Court } from "@/lib/types";

export type Occ = { id: string | null; court_id: string; start_at: string; end_at: string; status: string; mine: boolean; kind: "booking" | "block" };
type ClubX = Club & { booking_window_days: number; service_fee_usd: number; location_url: string | null; hold_minutes: number };

export default function PlayerGrid({ club, courts, occ, date }: { club: ClubX; courts: Court[]; occ: Occ[]; date: string }) {
  const router = useRouter();
  const times = slotTimes(club.open_time, club.close_time, club.slot_minutes);
  const ROW_PX = club.slot_minutes <= 30 ? 34 : 52;
  const labelEvery = club.slot_minutes <= 30 ? 2 : 1;
  const today = todayIn(club.timezone);
  const isToday = date === today;
  const lastDate = shiftDate(today, club.booking_window_days);
  const [nowMs] = useState(() => Date.now());

  const [pick, setPick] = useState<{ courtId: string; time: string } | null>(null);
  const [slots, setSlots] = useState(Math.round(club.min_booking_minutes / club.slot_minutes));
  const [price, setPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function slotStartMs(t: string) { return clubLocalToUtc(date, t, club.timezone).getTime(); }
  function isTaken(courtId: string, t: string) {
    const s = slotStartMs(t), e = s + club.slot_minutes * 60000;
    return occ.some((o) => o.court_id === courtId && new Date(o.start_at).getTime() < e && new Date(o.end_at).getTime() > s);
  }
  function isPast(t: string) { return slotStartMs(t) <= nowMs; }
  /** how many consecutive free slots from t, capped by the club max */
  function freeRun(courtId: string, t: string) {
    const i = times.indexOf(t);
    let n = 0;
    while (i + n < times.length && !isTaken(courtId, times[i + n]) && (n + 1) * club.slot_minutes <= club.max_booking_minutes) n++;
    return n;
  }
  const minSlots = Math.round(club.min_booking_minutes / club.slot_minutes);
  const maxSlotsHere = pick ? freeRun(pick.courtId, pick.time) : 0;

  // price quote for the current pick
  useEffect(() => {
    if (!pick) return;
    let cancelled = false;
    const start = clubLocalToUtc(date, pick.time, club.timezone);
    const end = new Date(start.getTime() + slots * club.slot_minutes * 60000);
    createClient().rpc("quote_price", { p_court: pick.courtId, p_start: start.toISOString(), p_end: end.toISOString() })
      .then(({ data, error }) => { if (!cancelled) setPrice(error ? null : Number(data)); });
    return () => { cancelled = true; };
  }, [pick, slots, date, club.timezone, club.slot_minutes]);

  async function reserve() {
    if (!pick) return;
    setBusy(true); setError(null);
    const start = clubLocalToUtc(date, pick.time, club.timezone);
    const end = new Date(start.getTime() + slots * club.slot_minutes * 60000);
    const { data, error } = await createClient().rpc("hold_slot", { p_club: club.id, p_court: pick.courtId, p_start: start.toISOString(), p_end: end.toISOString() });
    if (error) { setBusy(false); setError(friendlyError(error.message)); router.refresh(); return; }
    const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string };
    router.push(`/pay/${row.booking_id}`);
  }

  const endLabel = (t: string, n: number) => { const m = toMin(t) + n * club.slot_minutes; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  const fmtDur = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`);
  const dayLabel = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "EEEE d MMMM");

  return (
    <>
      <header className="px-4 pb-2 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight">{club.name}</h1>
        <p className="text-sm text-muted">
          {club.open_time.slice(0, 5)}–{club.close_time.slice(0, 5)} · book {fmtDur(club.min_booking_minutes)} to {fmtDur(club.max_booking_minutes)}
          {club.location_url && <> · <a className="underline" href={club.location_url} target="_blank" rel="noreferrer">Map</a></>}
        </p>
        <div className="mt-3 flex items-center justify-between">
          <Link aria-disabled={isToday} href={`/club/${club.slug}?date=${shiftDate(date, -1)}`} className={`grid h-10 w-10 place-items-center rounded-full border border-grid bg-white text-lg ${isToday ? "pointer-events-none opacity-30" : ""}`}>‹</Link>
          <div className="text-center font-medium">{isToday ? "Today" : dayLabel}{isToday && <div className="text-xs font-normal text-muted">{dayLabel}</div>}</div>
          <Link aria-disabled={date >= lastDate} href={`/club/${club.slug}?date=${shiftDate(date, 1)}`} className={`grid h-10 w-10 place-items-center rounded-full border border-grid bg-white text-lg ${date >= lastDate ? "pointer-events-none opacity-30" : ""}`}>›</Link>
        </div>
      </header>

      <div className="flex-1 overflow-x-auto px-2 pb-28">
        <div className="flex min-w-max">
          <div className="relative w-12 shrink-0" style={{ height: times.length * ROW_PX, marginTop: 36 }}>
            {times.map((t, i) => i % labelEvery === 0 && <div key={t} className="absolute right-2 -translate-y-1/2 text-xs text-muted" style={{ top: i * ROW_PX }}>{t}</div>)}
          </div>
          <div className="grid flex-1 gap-x-1.5" style={{ gridTemplateColumns: `repeat(${courts.length}, minmax(6.5rem, 1fr))` }}>
            {courts.map((c) => (
              <div key={c.id} className="h-9 px-1 text-center text-sm"><div className="font-medium leading-tight">{c.name}</div><div className="text-xs text-muted">{c.sport}</div></div>
            ))}
            {courts.map((c) => (
              <div key={c.id} className="relative rounded-lg border border-grid bg-white" style={{ height: times.length * ROW_PX }}>
                {times.map((t, i) => {
                  const taken = isTaken(c.id, t);
                  const past = isPast(t);
                  const selected = pick?.courtId === c.id && toMin(t) >= toMin(pick.time) && toMin(t) < toMin(pick.time) + slots * club.slot_minutes;
                  const bookable = !taken && !past && freeRun(c.id, t) >= minSlots;
                  return (
                    <button key={t} disabled={!bookable}
                      onClick={() => { setPick({ courtId: c.id, time: t }); setSlots(Math.min(minSlots, freeRun(c.id, t))); setPrice(null); setError(null); }}
                      className={`absolute inset-x-0 border-t text-xs first:border-t-0 ${i % labelEvery === 0 ? "border-grid" : "border-dashed border-grid/50"} ${
                        selected ? "bg-turf text-white" : taken ? "hatch bg-slate-soft text-muted" : past ? "bg-paper text-muted/60" : bookable ? "active:bg-turf-soft" : "text-muted/60"}`}
                      style={{ top: i * ROW_PX, height: ROW_PX }}>
                      {taken && i % labelEvery === 0 ? "Booked" : ""}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {pick && (
        <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-lg rounded-t-2xl border-t border-grid bg-white px-5 pb-6 pt-4 shadow-2xl">
          {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">{courts.find((c) => c.id === pick.courtId)?.name} · {pick.time}–{endLabel(pick.time, slots)}</h2>
            <button onClick={() => setPick(null)} className="text-sm text-muted">Close</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {Array.from({ length: maxSlotsHere }, (_, i) => i + 1).filter((n) => n >= minSlots).map((n) => (
              <button key={n} onClick={() => { setSlots(n); setPrice(null); }} className={`rounded-xl border px-3 py-2 text-sm ${slots === n ? "border-ink bg-ink text-white" : "border-grid"}`}>{fmtDur(n * club.slot_minutes)}</button>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-muted">Court {price === null ? "…" : `$${price.toFixed(2)}`} + booking fee ${Number(club.service_fee_usd).toFixed(2)}</span>
            <span className="text-lg font-semibold">{price === null ? "…" : `$${(price + Number(club.service_fee_usd)).toFixed(2)}`}</span>
          </div>
          <button disabled={busy || price === null} onClick={reserve} className="mt-3 w-full rounded-xl bg-action py-3.5 font-medium text-white disabled:opacity-50">
            {busy ? "Reserving…" : "Reserve and pay"}
          </button>
          <p className="mt-2 text-center text-xs text-muted">Slot is held for {club.hold_minutes} minutes while you pay. Free cancellation up to {club.cancel_cutoff_hours} h before.</p>
        </div>
      )}
    </>
  );
}
