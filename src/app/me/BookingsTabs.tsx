"use client";

import Link from "next/link";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { hhmm } from "@/lib/time";
import { agendaPill, type AgendaRow } from "@/lib/agenda";

const initialsOf = (name: string) => name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

function Pill({ r }: { r: AgendaRow }) { const [label, cls] = agendaPill(r); return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>; }

/** Club and title get the full width; date and time sit on their own line beneath. */
function Card({ r, note }: { r: AgendaRow; note?: string }) {
  return (
    <Link href={r.kind === "booking" ? `/bookings/${r.id}` : `/matches/${r.id}`} className="card flex flex-col gap-2.5 p-4">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{initialsOf(r.club_name)}</span>
        <div className="min-w-0 flex-1"><div className="text-base font-bold leading-tight">{r.title ?? (r.kind === "booking" ? "Court" : "Match")}</div><div className="text-[13px] text-muted">{r.club_name}</div></div>
      </div>
      <div className="flex items-center justify-between border-t border-grid pt-2.5">
        <span className="text-[15px] font-semibold">{formatInTimeZone(new Date(r.start_at), r.timezone, "EEE d MMM")} · {hhmm(r.start_at, r.timezone)}{r.end_at ? `–${hhmm(r.end_at, r.timezone)}` : ""}</span>
        <Pill r={r} />
      </div>
      {note && <div className="text-[13px] text-muted">{note}</div>}
    </Link>
  );
}

export default function BookingsTabs({ bookings, matches, past }: { bookings: AgendaRow[]; matches: AgendaRow[]; past: AgendaRow[] }) {
  const [tab, setTab] = useState<"courts" | "matches" | "history">(bookings.length === 0 && matches.length > 0 ? "matches" : "courts");
  const hero = bookings[0] ?? null;
  const chip = (on: boolean) => `chip ${on ? "chip-on" : ""}`;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5 pt-12">
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5">
        <button onClick={() => setTab("courts")} className={chip(tab === "courts")}>Courts ({bookings.length})</button>
        <button onClick={() => setTab("matches")} className={chip(tab === "matches")}>Matches ({matches.length})</button>
        <button onClick={() => setTab("history")} className={chip(tab === "history")}>History</button>
      </div>

      {tab === "courts" && (hero ? (
        <section className="flex flex-col gap-3">
          <h1 className="text-[26px] font-extrabold tracking-tight">Your next booking!</h1>
          <Link href={`/bookings/${hero.id}`} className="card overflow-hidden">
            <div className="relative h-28 bg-turf" aria-hidden="true"><div className="absolute inset-[18px_24px] rounded-md border-[3px] border-white/85" /><div className="absolute bottom-[18px] left-1/2 top-[18px] w-[3px] bg-white/85" /><div className="absolute left-6 right-6 top-1/2 h-[3px] bg-white/50" /><div className="absolute right-7 top-6 h-3.5 w-3.5 rounded-full bg-cedar" /></div>
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{initialsOf(hero.club_name)}</span>
                <div className="min-w-0 flex-1"><div className="text-[17px] font-bold leading-tight">{hero.title ?? "Court"}</div><div className="text-[13px] text-muted">{hero.club_name}</div></div>
              </div>
              <div className="flex items-center justify-between border-t border-grid pt-3">
                <span className="text-base font-bold">{formatInTimeZone(new Date(hero.start_at), hero.timezone, "EEE d MMM")} · {hhmm(hero.start_at, hero.timezone)}{hero.end_at ? `–${hhmm(hero.end_at, hero.timezone)}` : ""}</span>
                <Pill r={hero} />
              </div>
              <div className="text-[13px] text-muted">Tap for directions, share or cancel</div>
            </div>
          </Link>
          {bookings.length > 1 && <h2 className="pt-1 text-xl font-bold">Coming up</h2>}
          {bookings.slice(1).map((r) => <Card key={r.id} r={r} />)}
        </section>
      ) : (
        <section className="card p-6 text-center text-sm text-muted">No court booked yet. <Link href="/courts" className="font-semibold text-turf">Book a court</Link></section>
      ))}

      {tab === "matches" && (
        <section className="flex flex-col gap-3">
          <h1 className="flex items-center gap-2 text-[26px] font-extrabold tracking-tight"><span className="h-2.5 w-2.5 rounded-full bg-cedar" aria-hidden="true" />Matches you&apos;re in</h1>
          {matches.length === 0 && <p className="card p-6 text-center text-sm text-muted">No upcoming matches. <Link href="/play" className="font-semibold text-turf">Find a game</Link></p>}
          {matches.map((r) => <Card key={r.id} r={r} note="Open for players and chat" />)}
        </section>
      )}

      {tab === "history" && (
        <section className="flex flex-col gap-3">
          <h1 className="text-[26px] font-extrabold tracking-tight">History</h1>
          {past.length === 0 && <p className="card p-6 text-center text-sm text-muted">Nothing yet.</p>}
          <ul className="card divide-y divide-grid overflow-hidden">
            {past.map((r) => (
              <li key={r.kind + r.id}>
                <Link href={r.kind === "booking" ? `/bookings/${r.id}` : `/matches/${r.id}`} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1"><div className="truncate font-medium">{r.title ?? (r.kind === "booking" ? "Court" : "Match")}</div><div className="truncate text-[13px] text-muted">{r.club_name} · {formatInTimeZone(new Date(r.start_at), r.timezone, "EEE d MMM")} · {hhmm(r.start_at, r.timezone)}</div></div>
                  <Pill r={r} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
