"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import LevelRange from "@/components/LevelRange";
import { createClient } from "@/lib/supabase/client";
import PlayersNeeded from "@/components/PlayersNeeded";
import { friendlyError } from "@/lib/types";
import type { MatchRow } from "@/components/MatchBoard";

type Participant = { profile_id: string; name: string | null; level: number | null; level_legacy: string | null; is_organizer: boolean; status: string };

export default function MatchActions({ m, participants }: { m: MatchRow; participants: Participant[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: string, args: Record<string, unknown>) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc(fn, args);
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return false; }
    fetch("/api/notify/email", { method: "POST" }).catch(() => {});   // best-effort email fan-out
    router.refresh();
    return true;
  }
  const primary = "rounded-xl bg-action py-3.5 font-medium text-white disabled:opacity-50";
  const secondary = "rounded-xl border border-grid bg-white py-3.5";
  const pending = participants.filter((p) => p.status === "pending");
  const [editing, setEditing] = useState(false);
  const [manage, setManage] = useState(false);
  const [f, setF] = useState({ needed: m.players_needed, range: [m.level_min, m.level_max] as [number | null, number | null], note: m.note ?? "", joinMode: m.join_mode });
  const chip = (on: boolean) => `rounded-full border px-3 py-1.5 text-sm ${on ? "border-ink bg-ink text-white" : "border-grid bg-white"}`;
  const input = "rounded-xl border border-grid bg-white px-3 py-2 text-base outline-none focus:border-action";
  const save = async () => {
    if (await run("update_match", { p_match: m.match_id, p_players_needed: f.needed, p_level_min: f.range[0], p_level_max: f.range[1], p_note: f.note, p_join_mode: f.joinMode })) setEditing(false);
  };

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      {m.i_organize && pending.length > 0 && (
        <section className="rounded-2xl border border-sand bg-sand-soft p-4">
          <h2 className="mb-2 font-medium">Want to join</h2>
          <ul className="flex flex-col gap-2">
            {pending.map((p) => (
              <li key={p.profile_id} className="flex items-center justify-between text-sm">
                <span>{p.name ?? "Player"}{p.level != null ? ` · Level ${p.level}` : p.level_legacy ? ` · ${p.level_legacy}` : ""}</span>
                <span className="flex gap-3">
                  <button disabled={busy} onClick={() => run("decide_join", { p_match: m.match_id, p_profile: p.profile_id, p_accept: true })} className="font-medium text-action underline">Accept</button>
                  <button disabled={busy} onClick={() => run("decide_join", { p_match: m.match_id, p_profile: p.profile_id, p_accept: false })} className="text-muted underline">Decline</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {m.i_organize && m.status !== "cancelled" && (
        <button onClick={() => { setManage(!manage); setEditing(false); }} className={secondary}>{manage ? "Hide match settings ▴" : "Manage match ▾"}</button>
      )}
      {m.i_organize && m.status !== "cancelled" && manage && (
        editing ? (          <section className="flex flex-col gap-3 rounded-2xl border border-grid bg-white p-4">
            <h2 className="font-medium">Edit match</h2>
            <PlayersNeeded value={f.needed} onChange={(n) => setF({ ...f, needed: n })} min={m.joined} accepted={m.joined} />
            <div className="text-sm">Who is it for<div className="mt-1"><LevelRange value={f.range} onChange={(r) => setF({ ...f, range: r })} /></div></div>
            <div className="text-sm">Who can join<div className="mt-1 flex gap-2"><button type="button" onClick={() => setF({ ...f, joinMode: "open" })} className={chip(f.joinMode === "open")}>Anyone</button><button type="button" onClick={() => setF({ ...f, joinMode: "approval" })} className={chip(f.joinMode === "approval")}>I approve</button></div></div>
            <textarea className={input} rows={2} maxLength={300} placeholder="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
            <p className="text-xs text-muted">Time and club can&apos;t be changed — cancel and post a new match for that.</p>
            <div className="flex gap-2"><button disabled={busy} onClick={save} className={`${primary} flex-1`}>Save</button><button onClick={() => setEditing(false)} className={`${secondary} px-5`}>Cancel</button></div>
          </section>
        ) : (
          <button onClick={() => setEditing(true)} className={secondary}>Edit players, levels, note</button>
        )
      )}
      {m.i_organize ? (!manage ? null : m.status === "open" ? (
          <>
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "closed" })} className={primary}>Make it private — I have my players</button>
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "cancelled" })} className="py-2 text-sm text-danger">Cancel the match</button>
          </>
        ) : m.status === "closed" ? (
          <>
            {m.closed_reason === "full" ? (
              <>
                <p className="text-sm text-muted">Full, so it is off the match board. Want one more player? Edit it above and add a spot.</p>
                <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "closed" })} className={secondary}>Make it private — keep it off the board</button>
              </>
            ) : (
              <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "open" })} className={secondary}>Open it to players again</button>
            )}
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "cancelled" })} className="py-2 text-sm text-danger">Cancel the match</button>
          </>
        ) : <p className="text-sm text-muted">Cancelled.</p>
      ) : m.status === "cancelled" ? (
        <p className="text-sm text-muted">The organizer cancelled this match.</p>
      ) : m.my_status === "accepted" ? (
        <button disabled={busy} onClick={() => run("leave_match", { p_match: m.match_id })} className={secondary}>Leave</button>
      ) : m.my_status === "pending" ? (
        <>
          <p className="rounded-xl bg-paper p-3 text-center text-sm">Request sent — waiting for the organizer.</p>
          <button disabled={busy} onClick={() => run("leave_match", { p_match: m.match_id })} className="py-2 text-sm text-muted">Withdraw request</button>
        </>
      ) : m.my_status === "declined" ? (
        <p className="text-sm text-muted">The organizer could not take you this time.</p>
      ) : m.status === "open" ? (
        <button disabled={busy} onClick={() => run("join_match", { p_match: m.match_id })} className={primary}>{m.join_mode === "approval" ? "Ask to join" : "Join"}</button>
      ) : <p className="text-sm text-muted">{m.joined >= m.players_needed ? "This match is full." : "The organizer is not taking more players."}</p>}
    </div>
  );
}
