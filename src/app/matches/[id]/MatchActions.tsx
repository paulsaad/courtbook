"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";
import type { MatchRow } from "@/components/MatchBoard";

type Participant = { profile_id: string; name: string | null; level: string | null; is_organizer: boolean; status: string };

export default function MatchActions({ m, participants }: { m: MatchRow; participants: Participant[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: string, args: Record<string, unknown>) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc(fn, args);
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    fetch("/api/notify/email", { method: "POST" }).catch(() => {});   // best-effort email fan-out
    router.refresh();
  }
  const primary = "rounded-xl bg-action py-3.5 font-medium text-white disabled:opacity-50";
  const secondary = "rounded-xl border border-grid bg-white py-3.5";
  const pending = participants.filter((p) => p.status === "pending");

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      {m.i_organize && pending.length > 0 && (
        <section className="rounded-2xl border border-sand bg-sand-soft p-4">
          <h2 className="mb-2 font-medium">Want to join</h2>
          <ul className="flex flex-col gap-2">
            {pending.map((p) => (
              <li key={p.profile_id} className="flex items-center justify-between text-sm">
                <span>{p.name ?? "Player"}{p.level ? ` · ${p.level}` : ""}</span>
                <span className="flex gap-3">
                  <button disabled={busy} onClick={() => run("decide_join", { p_match: m.match_id, p_profile: p.profile_id, p_accept: true })} className="font-medium text-action underline">Accept</button>
                  <button disabled={busy} onClick={() => run("decide_join", { p_match: m.match_id, p_profile: p.profile_id, p_accept: false })} className="text-muted underline">Decline</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {m.i_organize ? (
        m.status === "open" ? (
          <>
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "closed" })} className={primary}>Close — I have my players</button>
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "cancelled" })} className="py-2 text-sm text-danger">Cancel the match</button>
          </>
        ) : m.status === "closed" ? (
          <>
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "open" })} className={secondary}>Reopen</button>
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "cancelled" })} className="py-2 text-sm text-danger">Cancel the match</button>
          </>
        ) : <p className="text-sm text-muted">Cancelled.</p>
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
      ) : <p className="text-sm text-muted">This match is {m.status}.</p>}
    </div>
  );
}
