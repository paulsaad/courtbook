"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { defaultLength } from "@/lib/labels";
import { useRouter } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { explainBookingError } from "@/lib/report";
import { BOOKING_OFFLINE, newToken, reserve as reserveSlot } from "@/lib/reserve";
import { selectionKey, tokenFor } from "@/lib/selection";
import { useDialog } from "@/components/useDialog";
import { DEMO_NOTE } from "@/lib/fees";
import { UNREADABLE, detailsPath, missingBeforeBooking } from "@/lib/playerDetails";

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
  const [wanted, setWanted] = useState(() => initialMinutes ?? (options.length ? defaultLength(options, club.slot_minutes) : club.min_minutes));
  // the duration in effect: the wanted one if this court allows it, else the longest valid one below it
  const minutes = options.includes(wanted) ? wanted : (options.filter((m) => m < wanted).pop() ?? options[0] ?? club.min_minutes);
  const valid = options.includes(minutes);
  const [quote, setQuote] = useState<{ key: string; q: Quote }>({ key: "", q: { state: "loading" } });
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const dialogRef = useDialog<HTMLElement>(true, onClose, { canClose: !busy });
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
  const tokenRef = useRef<{ key: string; token: string } | null>(null);   // one token per selection, reused if that selection is retried
  const inFlight = useRef(false);
  useEffect(() => {
    let alive = true;
    createClient().from("clubs").select("payment_mode").eq("id", club.id).single()
      .then(({ data }) => { if (alive && data) setMode((data.payment_mode as Mode) ?? "simulated"); });
    return () => { alive = false; };
  }, [club.id]);

  // The selection as of the latest render, so a details check that finishes later can see whether the player changed it.
  const selKey = selectionKey(court.id, start, minutes);
  const latestKey = useRef(selKey);
  useLayoutEffect(() => { latestKey.current = selKey; }, [selKey]);   // after each commit, before anything else can run

  async function reserve() {
    // one Reserve at a time: a second tap can land before `busy` disables the button
    if (inFlight.current) return;
    if (current.state !== "ok" || !valid || mode === null) return;
    // Frozen at the tap: only this exact court, start and length may be booked, whatever happens meanwhile.
    const sel = { mode, courtId: court.id, start, end, minutes };
    const key = selectionKey(sel.courtId, sel.start, sel.minutes);
    const q = new URLSearchParams({ date, at, court: sel.courtId, dur: String(sel.minutes) });   // encodes '+' inside timestamps
    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent(`/courts?${q}`)}`);
      return;
    }
    inFlight.current = true;
    let leaving = false;
    setBusy(true); setError(null);
    try {
      // a first booking needs the player's name and contact phone (asked once); back here with this slot selected
      const missing = await missingBeforeBooking(createClient());
      // The player picked another court or length while the details were read: book nothing. The new selection is
      // on screen with its own Reserve (the app does the same, #70).
      if (latestKey.current !== key) return;
      if (missing === "unreadable") { setError(UNREADABLE); return; }
      if (missing.length) { leaving = true; router.push(detailsPath(`/courts?${q}`)); return; }
      const token = tokenFor(tokenRef, key, newToken);   // a retry of this selection must not take a second court
      const r = await reserveSlot({ mode: sel.mode, clubId: club.id, courtId: sel.courtId, start: sel.start, end: sel.end, token });
      // #75: offline, say so and stay; a refresh would fail too and replace the page (and the selection) with the
      // browser's offline page. Retrying this same selection reuses its token, so it is safe.
      if (!r.ok) { setError(explainBookingError(r.message, r.code, r.offline ? BOOKING_OFFLINE : undefined)); if (!r.offline) router.refresh(); return; }
      leaving = true;
      router.push(r.value.href);
    } finally {
      // leaving the page keeps Reserve off; otherwise it is free again for the selection on screen
      if (!leaving) { inFlight.current = false; setBusy(false); }
    }
  }

  const atDesk = mode === "at_desk";
  const pill = (on: boolean) => `flex-1 rounded-2xl px-3 py-3 text-center text-[15px] ${on ? "bg-ink font-bold text-white" : "border border-grid bg-white font-semibold"}`;
  return (
    <div className="fixed inset-0 z-30 flex items-end bg-ink/45 lg:items-center lg:justify-center lg:p-6" onClick={() => { if (!busy) onClose(); }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Book ${club.name}, ${formatInTimeZone(start, club.timezone, "EEE d MMM HH:mm")}`} className="sheet-enter w-full rounded-t-3xl bg-white px-5 pt-3.5 shadow-2xl outline-none lg:max-h-[90vh] lg:max-w-lg lg:overflow-y-auto lg:rounded-3xl" style={{ paddingBottom: "calc(1.75rem + env(safe-area-inset-bottom))" }} onClick={(e) => e.stopPropagation()}>
        <span className="mx-auto mb-3 block h-1 w-11 rounded-full bg-[#d5d8d4]" aria-hidden="true" />
        <div className="flex items-center justify-between">
          <h2 className="text-[22px] font-extrabold tracking-tight">{formatInTimeZone(start, club.timezone, "EEE d MMM · HH:mm")}</h2>
          <button disabled={busy} onClick={onClose} className="text-sm text-muted disabled:opacity-50">Close</button>
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
            : `${mode === "simulated" ? `${DEMO_NOTE} · ` : ""}Slot held ${club.hold_minutes} minutes while you pay · free cancellation until ${club.cancel_cutoff_hours} h before`}
        </p>
      </section>
    </div>
  );
}
