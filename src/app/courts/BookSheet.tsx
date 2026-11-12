"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";
import { newToken, reserve as reserveSlot } from "@/lib/reserve";

export type SheetClub = { id: string; name: string; slug: string; slot_minutes: number; min_minutes: number; max_minutes: number; service_fee_usd: number; hold_minutes: number; cancel_cutoff_hours: number; timezone: string };

/** How this club settles money. club_day_slots does not carry it, so the sheet asks when it opens;
 *  until the answer arrives, Reserve waits rather than guessing which flow to use. */
type Mode = "simulated" | "at_desk" | null;
type Quote = { state: "loading" } | { state: "ok"; value: number } | { state: "error"; message: string };

/** Booking panel: court, duration, price, Reserve. Nothing is held until Reserve (hold_slot). */
export default function BookSheet({ club, date, at, courts, initialCourtId, initialMinutes, signedIn, onClose }: {
  club: SheetClub; date: string; at: string; courts: { id: string; name: string; free: number }[]; initialCourtId: string; initialMinutes: number | null; signedIn: boolean; onClose: () => void;
}) {
  const router = useRouter();
  const [courtId, setCourtId] = useState(initialCourtId);
  const court = courts.find((c) => c.id === courtId) ?? courts[0];
  // durations this court can take from this start: min..max in grid steps, within its free run
  const options = Array.from({ length: Math.floor(Math.min(court.free, club.max_minutes) / club.slot_minutes) }, (_, i) => (i + 1) * club.slot_minutes).filter((m) => m >= club.min_minutes);
  const [wanted, setWanted] = useState(() => initialMinutes ?? options[0] ?? club.min_minutes);
  // the duration in effect: the wanted one if this court allows it, else the longest valid one below it
  const minutes = options.includes(wanted) ? wanted : (options.filter((m) => m < wanted).pop() ?? options[0] ?? club.min_minutes);
  const valid = options.includes(minutes);
  const [quote, setQuote] = useState<{ key: string; q: Quote }>({ key: "", q: { state: "loading" } });
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = new Date(at);
  const end = new Date(start.getTime() + minutes * 60000);
  const fmtDur = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`);

  // one quote per (court, start, duration); an answer is used only if it matches the current selection
  const qKey = `${court.id}|${at}|${minutes}|${retry}`;
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    createClient().rpc("quote_price", { p_court: court.id, p_start: start.toISOString(), p_end: end.toISOString() }).then(({ data, error }) => {
      if (cancelled) return;
      const q: Quote = error
        ? { state: "error", message: error.message.includes("no_price_rule") ? "No price is set for this time yet — the club has to add a price rule." : "Could not load the price." }
        : { state: "ok", value: Number(data) };
      setQuote({ key: qKey, q });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qKey, valid]);
  const current: Quote = quote.key === qKey ? quote.q : { state: "loading" };
  const total = current.state === "ok" ? current.value + club.service_fee_usd : null;

  const [mode, setMode] = useState<Mode>(null);
  const tokenRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    createClient().from("clubs").select("payment_mode").eq("id", club.id).single()
      .then(({ data }) => { if (alive && data) setMode((data.payment_mode as Mode) ?? "simulated"); });
    return () => { alive = false; };
  }, [club.id]);

  async function reserve() {
    if (current.state !== "ok" || !valid || mode === null) return;
    if (!signedIn) {
      const q = new URLSearchParams({ date, at, court: court.id, dur: String(minutes) });   // encodes '+' inside timestamps
      router.push(`/login?next=${encodeURIComponent(`/courts?${q}`)}`);
      return;
    }
    setBusy(true); setError(null);
    const token = tokenRef.current ?? (tokenRef.current = newToken());   // a retry must not take a second court
    const r = await reserveSlot({ mode, clubId: club.id, courtId: court.id, start, end, token });
    if (!r.ok) { setBusy(false); setError(friendlyError(r.message)); router.refresh(); return; }
    router.push(r.value.href);
  }

  const atDesk = mode === "at_desk";
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
        <div className="mt-4 flex flex-col gap-2"><div className="eyebrow">Court</div><div className="flex gap-2">{courts.map((c) => <button key={c.id} onClick={() => setCourtId(c.id)} className={pill(c.id === court.id)}>{c.name}</button>)}</div></div>
        <div className="mt-4 flex flex-col gap-2"><div className="eyebrow">Duration</div><div className="flex gap-2">{options.map((m) => <button key={m} onClick={() => setWanted(m)} className={pill(m === minutes)}>{fmtDur(m)}</button>)}</div></div>
        <div className="mt-4 text-sm text-muted">
          {fmtDur(minutes)} · ends {formatInTimeZone(end, club.timezone, "HH:mm")}
          {minutes !== wanted && <span className="text-sand"> · {fmtDur(wanted)} isn&apos;t free on {court.name}</span>}
        </div>
        {current.state === "error" ? (
          <p className="mt-3 flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{current.message}{current.message.startsWith("Could") && <button onClick={() => setRetry((n) => n + 1)} className="font-semibold underline">Retry</button>}</p>
        ) : (
          <div className="mt-3 flex items-center justify-between">
            <span className="text-sm text-muted">{atDesk ? "Pay at the club" : `Court ${current.state === "ok" ? `$${current.value.toFixed(2)}` : "…"} + booking fee $${club.service_fee_usd.toFixed(2)}`}</span>
            <span className="text-2xl font-extrabold tracking-tight">{atDesk ? (current.state === "ok" ? `$${current.value.toFixed(2)}` : "…") : total !== null ? `$${total.toFixed(2)}` : "…"}</span>
          </div>
        )}
        <button disabled={busy || total === null || !valid || mode === null} onClick={reserve} className="btn btn-primary mt-4">
          {busy ? "Reserving…" : !signedIn ? "Sign in to reserve" : atDesk ? "Reserve — you pay at the club" : `Reserve and pay${total !== null ? ` $${total.toFixed(2)}` : ""}`}
        </button>
        <p className="mt-2 text-center text-xs text-muted">
          {atDesk
            ? `Confirmed straight away · nothing is paid through the app · free cancellation until ${club.cancel_cutoff_hours} h before`
            : `Slot held ${club.hold_minutes} minutes while you pay · free cancellation until ${club.cancel_cutoff_hours} h before`}
        </p>
      </section>
    </div>
  );
}
