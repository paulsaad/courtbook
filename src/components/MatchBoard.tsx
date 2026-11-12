"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import LevelRange from "./LevelRange";
import PlayersNeeded from "./PlayersNeeded";
import { fitLabel, rangeLabel } from "@/lib/levels";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { clubLocalToUtc, hhmm, todayIn } from "@/lib/time";
import { friendlyError } from "@/lib/types";

export type MatchRow = {
  match_id: string; club_id: string; club_name: string; club_slug: string; sport: string; start_at: string; end_at: string | null;
  level_min: number | null; level_max: number | null; level_legacy: boolean; my_level: number | null; players_needed: number; joined: number; pending: number; status: string; closed_reason: string | null; note: string | null; join_mode: string;
  organizer_id: string; organizer_name: string | null; my_status: string | null; i_organize: boolean; booking_id: string | null; court_name: string | null;
};
type ClubX = { id: string; name: string; slug: string; timezone: string; open_time: string; close_time: string; slot_minutes: number };
type MyBooking = { id: string; start_at: string; end_at: string; courts: { name: string } | null };

const input = "rounded-xl border border-grid bg-white px-3 py-2.5 text-base outline-none focus:border-action";
const chip = (on: boolean) => `rounded-xl border px-3 py-2 text-sm ${on ? "border-ink bg-ink text-white" : "border-grid bg-white"}`;

export function MatchCard({ m, tz }: { m: MatchRow; tz: string }) {
  const spots = m.players_needed - m.joined;
  return (
    <Link href={`/matches/${m.match_id}`} className="block rounded-2xl border border-grid bg-white p-4 active:bg-paper">
      <div className="flex items-baseline justify-between">
        <span className="font-medium">{formatInTimeZone(new Date(m.start_at), tz, "EEE d MMM · HH:mm")}{m.end_at ? `–${hhmm(m.end_at, tz)}` : ""}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${m.status === "open" ? "bg-turf-soft text-turf" : "bg-slate-soft text-muted"}`}>{m.status === "open" ? `${spots} spot${spots === 1 ? "" : "s"} left` : m.status === "cancelled" ? "Cancelled" : m.closed_reason === "full" ? "Full" : "Private"}</span>
      </div>
      <div className="mt-1 text-sm text-muted">{m.sport} · {rangeLabel(m.level_min, m.level_max, m.level_legacy)}{m.court_name ? ` · ${m.court_name} booked` : ""} · by {m.organizer_name ?? "player"}{m.i_organize ? " (you)" : m.my_status === "accepted" ? " · you're in" : m.my_status === "pending" ? " · requested" : ""}{m.i_organize && m.pending > 0 ? ` · ${m.pending} waiting` : ""}</div>
      {!m.i_organize && m.level_min != null && (() => { const f = fitLabel(m.my_level, m.level_min, m.level_max); return <div className={`mt-1 text-xs ${f.tone === "ok" ? "text-turf" : f.tone === "warn" ? "text-sand" : "text-muted"}`}>{f.text}</div>; })()}
      {m.note && <p className="mt-2 text-sm">{m.note}</p>}
    </Link>
  );
}

export default function MatchBoard({ club, rows, myBookings, sports }: { club: ClubX; rows: MatchRow[]; myBookings: MyBooking[]; sports: { code: string; name_en: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = todayIn(club.timezone);
  const [f, setF] = useState({ sport: sports[0]?.code ?? "padel", range: [null, null] as [number | null, number | null], date: today, time: "18:00", needed: 3, note: "", bookingId: "", joinMode: "open" });

  async function post(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const start = f.bookingId ? null : clubLocalToUtc(f.date, f.time, club.timezone).toISOString();
    const end = f.bookingId || !start ? null : new Date(new Date(start).getTime() + 90 * 60000).toISOString();
    const { data, error } = await createClient().rpc("post_match", {
      p_club: club.id, p_sport: f.sport, p_start: start, p_end: end, p_level_min: f.range[0], p_level_max: f.range[1],
      p_players_needed: f.needed, p_note: f.note, p_booking: f.bookingId || null, p_join_mode: f.joinMode,
    });
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    router.push(`/matches/${data as string}`);
  }

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Find players</h1>
        <button onClick={() => setOpen(!open)} className="rounded-xl bg-action px-4 py-2 text-sm font-medium text-white">{open ? "Close" : "Post a match"}</button>
      </div>

      {open && (
        <form onSubmit={post} className="flex flex-col gap-3 rounded-2xl border border-grid bg-white p-4">
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">{sports.map((sp) => <button type="button" key={sp.code} onClick={() => setF({ ...f, sport: sp.code })} className={chip(f.sport === sp.code)}>{sp.name_en}</button>)}</div>
          {myBookings.length > 0 && (
            <label className="flex flex-col gap-1 text-sm">Link one of your bookings (optional)
              <select className={input} value={f.bookingId} onChange={(e) => setF({ ...f, bookingId: e.target.value })}>
                <option value="">No booking yet — just a time</option>
                {myBookings.map((b) => <option key={b.id} value={b.id}>{formatInTimeZone(new Date(b.start_at), club.timezone, "EEE d MMM HH:mm")}–{hhmm(b.end_at, club.timezone)} · {b.courts?.name}</option>)}
              </select>
            </label>
          )}
          {!f.bookingId && (
            <div className="flex gap-2">
              <input className={`${input} flex-1`} type="date" min={today} required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
              <input className={input} type="time" step={1800} required value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
            </div>
          )}
          <div className="text-sm">Who is it for<div className="mt-1"><LevelRange value={f.range} onChange={(r) => setF({ ...f, range: r })} /></div></div>
          <PlayersNeeded value={f.needed} onChange={(n) => setF({ ...f, needed: n })} />
          <div className="text-sm">Who can join<div className="mt-1 flex gap-2">{[["open", "anyone"], ["approval", "I approve each player"]].map(([v, l]) => <button type="button" key={v} onClick={() => setF({ ...f, joinMode: v })} className={chip(f.joinMode === v)}>{l}</button>)}</div></div>
          <input className={input} placeholder="Note (optional): e.g. friendly doubles, bring balls" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <button disabled={busy} className="rounded-xl bg-action py-3 font-medium text-white disabled:opacity-50">{busy ? "Posting…" : "Post"}</button>
        </form>
      )}

      {rows.length === 0 && !open && <p className="text-muted">No open matches in the next two weeks. Post one.</p>}
      <ul className="flex flex-col gap-3">{rows.map((m) => <li key={m.match_id}><MatchCard m={m} tz={club.timezone} /></li>)}</ul>
    </>
  );
}
