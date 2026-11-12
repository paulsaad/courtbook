"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";
import LevelRange from "@/components/LevelRange";
import PlayersNeeded from "@/components/PlayersNeeded";
import { rangeLabel } from "@/lib/levels";

export type BookingMatch = { match_id: string; status: string; closed_reason: string | null; players_needed: number; joined: number; pending: number; level_min: number | null; level_max: number | null; join_mode: string } | null;

/** On a booking: keep it private, or open it so other players can join (a match linked to this booking). */
export default function OpenToPlayers({ bookingId, sport, sportName, match }: { bookingId: string; sport: string; sportName: string; match: BookingMatch }) {
  const router = useRouter();
  const [form, setForm] = useState(false);
  const [f, setF] = useState({ needed: 1, range: [null, null] as [number | null, number | null], joinMode: "open", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPrivate, setConfirmPrivate] = useState(false);

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true); setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return false; }
    setForm(false); setConfirmPrivate(false); router.refresh();
    return true;
  }
  const open = () => run(() => createClient().rpc("post_match", {
    p_club: null, p_sport: sport, p_start: null, p_end: null,
    p_level_min: f.range[0], p_level_max: f.range[1], p_players_needed: f.needed, p_note: f.note, p_booking: bookingId, p_join_mode: f.joinMode,
  }));
  const setStatus = (status: string) => run(() => createClient().rpc("set_match_status", { p_match: match!.match_id, p_status: status }));

  const chip = (on: boolean) => `chip ${on ? "chip-on" : ""}`;

  if (match) {
    const spots = Math.max(0, match.players_needed - match.joined);
    // a match closes itself the moment it fills up — that is not the same as the organizer hiding it
    const full = match.status !== "open" && match.closed_reason === "full";
    const hidden = match.status !== "open" && !full;
    const state = match.status === "open"
      ? `${spots} spot${spots === 1 ? "" : "s"} left`
      : full ? "Full — your players have joined" : "Private — nobody new can see it";
    return (
      <section className="card flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${match.status === "open" ? "bg-cedar" : "bg-slate-soft"}`} aria-hidden="true" /><h2 className="font-bold">{match.status === "open" ? "Open to other players" : full ? "Your match is full" : "Private match"}</h2></div>
            <p className="mt-1 text-sm text-muted">{rangeLabel(match.level_min, match.level_max)} · {state}{match.pending > 0 ? ` · ${match.pending} waiting for your answer` : ""}</p>
          </div>
          <Link href={`/matches/${match.match_id}`} className="shrink-0 text-sm font-semibold text-turf">Open ›</Link>
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
        {match.joined === 0 ? (
          confirmPrivate
            ? <div className="flex gap-2"><button disabled={busy} onClick={() => setStatus("cancelled")} className="btn btn-primary flex-1">Make it private</button><button onClick={() => setConfirmPrivate(false)} className="btn btn-secondary px-5">Keep</button></div>
            : <button onClick={() => setConfirmPrivate(true)} className="btn btn-secondary">Make it private again</button>
        ) : hidden ? (
          <button disabled={busy} onClick={() => setStatus("open")} className="btn btn-secondary">Open it to players again</button>
        ) : (
          <button disabled={busy} onClick={() => setStatus("closed")} className="btn btn-secondary">Make it private</button>
        )}
        {match.joined > 0 && (
          <p className="text-xs text-muted">
            {match.joined} player{match.joined === 1 ? " has" : "s have"} joined.{" "}
            {match.status === "open"
              ? "Make it private and they stay in — it just disappears from the match board, and anyone still waiting is told."
              : full
                ? "It left the board on its own when the last spot went. Want one more player? Open the match and add a spot. Make it private and it stays off the board even if someone drops out."
                : "They are still in. To cancel on them, open the match and cancel it there — they are notified."}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="card flex flex-col gap-3 p-4">
      <div>
        <h2 className="font-bold">Private booking</h2>
        <p className="mt-1 text-sm text-muted">Only you can see it. Missing players? Open it and others can ask to join your {sportName.toLowerCase()} game.</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      {!form ? (
        <button onClick={() => setForm(true)} className="btn btn-primary">Open to other players</button>
      ) : (
        <>
          <PlayersNeeded value={f.needed} onChange={(n) => setF({ ...f, needed: n })} />
          <div className="text-sm">Who is it for<div className="mt-1"><LevelRange value={f.range} onChange={(r) => setF({ ...f, range: r })} /></div></div>
          <div className="text-sm">Who can join<div className="mt-1 flex gap-2"><button type="button" onClick={() => setF({ ...f, joinMode: "open" })} className={chip(f.joinMode === "open")}>Anyone</button><button type="button" onClick={() => setF({ ...f, joinMode: "approval" })} className={chip(f.joinMode === "approval")}>I approve each player</button></div></div>
          <input className="rounded-xl border border-grid px-3 py-2.5 text-base outline-none focus:border-action" maxLength={300} placeholder="Note (optional): friendly game, bring balls…" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <div className="flex gap-2"><button disabled={busy} onClick={open} className="btn btn-primary flex-1 whitespace-nowrap">{busy ? "Opening…" : "Open to players"}</button><button onClick={() => setForm(false)} className="btn btn-secondary shrink-0 px-5">Cancel</button></div>
        </>
      )}
    </section>
  );
}
