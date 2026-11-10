"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { clubLocalToUtc, dayBounds, hhmm, shiftDate, slotTimes, todayIn, toMin } from "@/lib/time";
import { friendlyError, type Club, type Court } from "@/lib/types";
import { readPrefs } from "@/lib/prefs";

export type Occ = { id?: string | null; court_id: string; start_at: string; end_at: string; status?: string; mine?: boolean; kind: "booking" | "block" };
type ClubX = Club & { booking_window_days: number; service_fee_usd: number; location_url: string | null; hold_minutes: number };
type Hold = { booking_id: string; court_name: string; start_at: string; end_at: string; hold_expires_at: string } | null;
type Preselect = { date: string; time: string; courtId: string } | null;

const chip = (on: boolean) => `shrink-0 rounded-full border px-3.5 py-1.5 text-sm ${on ? "border-ink bg-ink text-white" : "border-grid bg-white"}`;

export default function PlayerGrid({ signedIn, club, courts: allCourts, occ: initialOcc, date: initialDate, hold, preselect, sportNames }: {
  signedIn: boolean; club: ClubX; courts: Court[]; occ: Occ[]; date: string; hold: Hold; preselect: Preselect; sportNames: Record<string, string>;
}) {
  const router = useRouter();
  const times = slotTimes(club.open_time, club.close_time, club.slot_minutes);
  const ROW_PX = club.slot_minutes <= 30 ? 34 : 52;
  const labelEvery = club.slot_minutes <= 30 ? 2 : 1;
  const today = todayIn(club.timezone);
  const [nowMs] = useState(() => Date.now());
  const days = Array.from({ length: club.booking_window_days + 1 }, (_, i) => shiftDate(today, i));

  const [date, setDate] = useState(initialDate);
  // occupancy: the server gives today's; other days are fetched on the client (no page reload)
  const [fetched, setFetched] = useState<{ date: string; occ: Occ[] } | null>(null);
  const occ = date === initialDate ? initialOcc : fetched?.date === date ? fetched.occ : [];
  const loading = date !== initialDate && fetched?.date !== date;
  const sports = [...new Set(allCourts.map((c) => c.sport))];
  const [sport, setSport] = useState<string | null>(null);
  const courts = sport && sports.includes(sport) ? allCourts.filter((c) => c.sport === sport) : allCourts;

  const [pick, setPick] = useState<{ courtId: string; time: string } | null>(preselect && preselect.date === initialDate ? { courtId: preselect.courtId, time: preselect.time } : null);
  const [slots, setSlots] = useState(Math.round(club.min_booking_minutes / club.slot_minutes));
  const [price, setPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  // remembered sport from Home, if this club has it
  useEffect(() => {
    const t = setTimeout(() => { const p = readPrefs().sport; if (p && sports.length > 1 && sports.includes(p)) setSport(p); }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (date === initialDate) return;
    let alive = true;
    (async () => {
      const { dayStart, dayEnd } = dayBounds(date, club.timezone);
      const sb = createClient();
      const { data } = signedIn
        ? await sb.from("occupancy").select("id, court_id, start_at, end_at, status, mine, kind").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart)
        : await sb.from("public_occupancy").select("court_id, start_at, end_at, kind").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart);
      if (alive) setFetched({ date, occ: (data ?? []) as Occ[] });
    })();
    return () => { alive = false; };
  }, [date, initialDate, club.id, club.timezone, signedIn]);

  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>("[data-on=true]");
    el?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [date]);

  function slotStartMs(t: string) { return clubLocalToUtc(date, t, club.timezone).getTime(); }
  function isTaken(courtId: string, t: string) {
    const s = slotStartMs(t), e = s + club.slot_minutes * 60000;
    return occ.some((o) => o.court_id === courtId && new Date(o.start_at).getTime() < e && new Date(o.end_at).getTime() > s);
  }
  function isPast(t: string) { return slotStartMs(t) <= nowMs; }
  function myHoldAt(courtId: string, t: string) {
    const s = slotStartMs(t), e = s + club.slot_minutes * 60000;
    return occ.find((o) => o.mine && o.status === "pending" && o.court_id === courtId && new Date(o.start_at).getTime() < e && new Date(o.end_at).getTime() > s) ?? null;
  }
  function freeRun(courtId: string, t: string) {
    const i = times.indexOf(t);
    let n = 0;
    while (i + n < times.length && !isTaken(courtId, times[i + n]) && (n + 1) * club.slot_minutes <= club.max_booking_minutes) n++;
    return n;
  }
  const minSlots = Math.round(club.min_booking_minutes / club.slot_minutes);
  const maxSlotsHere = pick ? freeRun(pick.courtId, pick.time) : 0;

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
    const start = clubLocalToUtc(date, pick.time, club.timezone);
    if (!signedIn) {
      // sign in, then come back with this slot selected
      router.push(`/login?next=${encodeURIComponent(`/club/${club.slug}?at=${start.toISOString()}&court=${pick.courtId}`)}`);
      return;
    }
    setBusy(true); setError(null);
    const end = new Date(start.getTime() + slots * club.slot_minutes * 60000);
    const { data, error } = await createClient().rpc("hold_slot", { p_club: club.id, p_court: pick.courtId, p_start: start.toISOString(), p_end: end.toISOString() });
    if (error) { setBusy(false); setError(friendlyError(error.message)); router.refresh(); return; }
    const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string };
    router.push(`/pay/${row.booking_id}`);
  }

  const changeDate = (d: string) => { setDate(d); setPick(null); setError(null); };
  const endLabel = (t: string, n: number) => { const m = toMin(t) + n * club.slot_minutes; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  const fmtDur = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`);
  const dayOf = (d: string) => clubLocalToUtc(d, "12:00", club.timezone);

  return (
    <>
      {/* date strip */}
      <div ref={stripRef} className="mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
        {days.map((d) => {
          const on = d === date;
          return (
            <button key={d} data-on={on} onClick={() => changeDate(d)} className={`flex w-12 shrink-0 flex-col items-center rounded-2xl border py-2 ${on ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>
              <span className={`text-[11px] uppercase ${on ? "opacity-80" : "text-muted"}`}>{d === today ? "Today" : formatInTimeZone(dayOf(d), club.timezone, "EEE")}</span>
              <span className="text-lg font-semibold leading-tight">{formatInTimeZone(dayOf(d), club.timezone, "d")}</span>
              <span className={`text-[10px] ${on ? "opacity-80" : "text-muted"}`}>{formatInTimeZone(dayOf(d), club.timezone, "MMM")}</span>
            </button>
          );
        })}
      </div>

      {sports.length > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto px-4">
          <button onClick={() => { setSport(null); setPick(null); }} className={chip(!sport)}>All</button>
          {sports.map((sp) => <button key={sp} onClick={() => { setSport(sp); setPick(null); }} className={chip(sport === sp)}>{sportNames[sp] ?? sp}</button>)}
        </div>
      )}

      <p className="px-4 pt-2 text-xs text-muted">Book {fmtDur(club.min_booking_minutes)} to {fmtDur(club.max_booking_minutes)} · tap a free slot{loading ? " · loading…" : ""}</p>

      {hold && (
        <Link href={`/pay/${hold.booking_id}`} className="mx-4 mt-2 flex items-center justify-between rounded-xl bg-turf px-4 py-3 text-sm text-white">
          <span>Slot on hold: {hold.court_name}, {hhmm(hold.start_at, club.timezone)}–{hhmm(hold.end_at, club.timezone)}</span>
          <span className="font-medium">Continue to payment ›</span>
        </Link>
      )}

      <div className={`flex-1 overflow-x-auto px-2 pb-28 pt-2 ${loading ? "opacity-60" : ""}`}>
        <div className="flex min-w-max">
          <div className="relative w-12 shrink-0" style={{ height: times.length * ROW_PX, marginTop: 36 }}>
            {times.map((t, i) => i % labelEvery === 0 && <div key={t} className="absolute right-2 -translate-y-1/2 text-xs text-muted" style={{ top: i * ROW_PX }}>{t}</div>)}
          </div>
          <div className="grid flex-1 gap-x-1.5" style={{ gridTemplateColumns: `repeat(${courts.length}, minmax(6.5rem, 1fr))` }}>
            {courts.map((c) => (
              <div key={c.id} className="h-9 px-1 text-center text-sm"><div className="font-medium leading-tight">{c.name}</div><div className="text-xs text-muted">{sportNames[c.sport] ?? c.sport}</div></div>
            ))}
            {courts.map((c) => (
              <div key={c.id} className="relative rounded-lg border border-grid bg-white" style={{ height: times.length * ROW_PX }}>
                {times.map((t, i) => {
                  const taken = isTaken(c.id, t);
                  const past = isPast(t);
                  const mine = myHoldAt(c.id, t);
                  if (mine) {
                    return (
                      <button key={t} onClick={() => router.push(`/pay/${mine.id}`)} className="absolute inset-x-0 border-t border-dashed border-turf bg-turf-soft text-xs font-medium text-turf" style={{ top: i * ROW_PX, height: ROW_PX }}>
                        {i % labelEvery === 0 ? "Your hold · pay" : ""}
                      </button>
                    );
                  }
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
        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-lg rounded-t-2xl border-t border-grid bg-white px-5 pb-8 pt-4 shadow-2xl">
          {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">{allCourts.find((c) => c.id === pick.courtId)?.name} · {pick.time}–{endLabel(pick.time, slots)}</h2>
            <button onClick={() => setPick(null)} className="text-sm text-muted">Close</button>
          </div>
          <p className="text-sm text-muted">{date === today ? "Today" : formatInTimeZone(dayOf(date), club.timezone, "EEEE d MMMM")}</p>
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
            {busy ? "Reserving…" : signedIn ? "Reserve and pay" : "Sign in to reserve"}
          </button>
          <p className="mt-2 text-center text-xs text-muted">Slot is held for {club.hold_minutes} minutes while you pay. Free cancellation up to {club.cancel_cutoff_hours} h before.</p>
        </div>
      )}
    </>
  );
}
