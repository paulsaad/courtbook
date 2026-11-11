"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

export type SheetClub = { id: string; name: string; slug: string; slot_minutes: number; min_minutes: number; max_minutes: number; service_fee_usd: number; hold_minutes: number; cancel_cutoff_hours: number; timezone: string };
type Quote = { state: "loading" } | { state: "ok"; value: number } | { state: "error"; message: string };

/** Booking panel: court, duration, price, Reserve. Nothing is held until Reserve (hold_slot). */
export default function BookSheet({ club, date, at, courts, initialCourtId, initialMinutes, signedIn, onClose }: {
  club: SheetClub; date: string; at: string; courts: { id: string; name: string; free: number }[]; initialCourtId: string; initialMinutes: number | null; signedIn: boolean; onClose: () => void;
}) {
  const router = useRouter();
  const [courtId, setCourtId] = useState(initialCourtId);
  const court = courts.find((c) => c.id === courtId) ?? courts[0];
  const options = Array.from({ length: Math.floor(Math.min(court.free, club.max_minutes) / club.slot_minutes) }, (_, i) => (i + 1) * club.slot_minutes).filter((m) => m >= club.min_minutes);
  const [minutes, setMinutes] = useState(() => (initialMinutes && options.includes(initialMinutes) ? initialMinutes : options[0] ?? club.min_minutes));
  const [quote, setQuote] = useState<Quote>({ state: "loading" });
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = new Date(at);
  const end = new Date(start.getTime() + minutes * 60000);
  const fmtDur = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`);

  useEffect(() => {
    let cancelled = false;
    createClient().rpc("quote_price", { p_court: court.id, p_start: start.toISOString(), p_end: end.toISOString() }).then(({ data, error }) => {
      if (cancelled) return;
      if (error) setQuote({ state: "error", message: error.message.includes("no_price_rule") ? "No price is set for this time yet — the club has to add a price rule." : "Could not load the price." });
      else setQuote({ state: "ok", value: Number(data) });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [court.id, minutes, at, tick]);

  async function reserve() {
    if (quote.state !== "ok") return;
    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent(`/courts?date=${date}&at=${at}&court=${court.id}&dur=${minutes}`)}`);
      return;
    }
    setBusy(true); setError(null);
    const { data, error } = await createClient().rpc("hold_slot", { p_club: club.id, p_court: court.id, p_start: start.toISOString(), p_end: end.toISOString() });
    if (error) { setBusy(false); setError(friendlyError(error.message)); router.refresh(); return; }
    const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string };
    router.push(`/pay/${row.booking_id}`);
  }

  const pill = (on: boolean) => `flex-1 rounded-2xl px-3 py-3 text-center text-[15px] ${on ? "bg-ink font-bold text-white" : "border border-grid bg-white font-semibold"}`;
  return (
    <div className="fixed inset-0 z-30 flex items-end bg-ink/45" onClick={onClose}>
      <section className="sheet-enter w-full rounded-t-3xl bg-white px-5 pt-3.5 shadow-2xl" style={{ paddingBottom: "calc(1.75rem + env(safe-area-inset-bottom))" }} onClick={(e) => e.stopPropagation()}>
        <span className="mx-auto mb-3 block h-1 w-11 rounded-full bg-[#d5d8d4]" aria-hidden="true" />
        <div className="flex items-center justify-between">
          <h2 className="text-[22px] font-extrabold tracking-tight">{formatInTimeZone(start, club.timezone, "EEE d MMM · HH:mm")}</h2>
          <button onClick={onClose} className="text-sm text-muted">Close</button>
        </div>
        <div className="mt-1 text-sm text-muted">{club.name}</div>
        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex flex-col gap-2"><div className="eyebrow">Court</div><div className="flex gap-2">{courts.map((c) => <button key={c.id} onClick={() => { setCourtId(c.id); setQuote({ state: "loading" }); }} className={pill(c.id === court.id)}>{c.name}</button>)}</div></div>
        <div className="mt-4 flex flex-col gap-2"><div className="eyebrow">Duration</div><div className="flex gap-2">{options.map((m) => <button key={m} onClick={() => { setMinutes(m); setQuote({ state: "loading" }); }} className={pill(m === minutes)}>{fmtDur(m)}</button>)}</div></div>
        <div className="mt-4 text-sm text-muted">Ends {formatInTimeZone(end, club.timezone, "HH:mm")}</div>
        {quote.state === "error" ? (
          <p className="mt-3 flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{quote.message}{quote.message.startsWith("Could") && <button onClick={() => { setQuote({ state: "loading" }); setTick((n) => n + 1); }} className="font-semibold underline">Retry</button>}</p>
        ) : (
          <div className="mt-3 flex items-center justify-between"><span className="text-sm text-muted">Court {quote.state === "ok" ? `$${quote.value.toFixed(2)}` : "…"} + booking fee ${club.service_fee_usd.toFixed(2)}</span><span className="text-2xl font-extrabold tracking-tight">{quote.state === "ok" ? `$${(quote.value + club.service_fee_usd).toFixed(2)}` : "…"}</span></div>
        )}
        <button disabled={busy || quote.state !== "ok"} onClick={reserve} className="btn btn-primary mt-4">{busy ? "Reserving…" : signedIn ? `Reserve and pay${quote.state === "ok" ? ` $${(quote.value + club.service_fee_usd).toFixed(2)}` : ""}` : "Sign in to reserve"}</button>
        <p className="mt-2 text-center text-xs text-muted">Slot held {club.hold_minutes} minutes while you pay · free cancellation until {club.cancel_cutoff_hours} h before</p>
      </section>
    </div>
  );
}
