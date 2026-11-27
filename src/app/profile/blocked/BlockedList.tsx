"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import SafetyConfirm from "@/components/SafetyConfirm";
import { type BlockedPlayer, UNBLOCK_EXPLAINED, unblockPlayer } from "@/lib/gameSafety";

/** The list with Unblock on each row; unblocking asks first (as the app), then the row goes. */
export default function BlockedList({ initial }: { initial: BlockedPlayer[] }) {
  const [rows, setRows] = useState(initial);
  const [asking, setAsking] = useState<BlockedPlayer | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function unblock(p: BlockedPlayer): Promise<string | null> {
    const problem = await unblockPlayer((fn, args) => createClient().rpc(fn, args), p.profile_id);
    if (problem) return problem;
    setRows((cur) => cur.filter((r) => r.profile_id !== p.profile_id));
    setDone(`You unblocked ${p.name ?? "this player"}.`);
    return null;
  }

  return (
    <section className="card p-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">You haven&apos;t blocked anyone.</p>
      ) : (
        <ul className="divide-y divide-grid text-sm">
          {rows.map((b) => (
            <li key={b.profile_id} className="flex items-center justify-between gap-3 py-2">
              <span className="truncate font-medium">{b.name ?? "Player"}</span>
              <button type="button" onClick={() => { setDone(null); setAsking(b); }} className="min-h-11 rounded-xl border border-grid bg-white px-4 font-medium">Unblock</button>
            </li>
          ))}
        </ul>
      )}
      {done && <p role="status" className="mt-3 text-sm">{done}</p>}
      {asking && (
        <SafetyConfirm title={`Unblock ${asking.name ?? "this player"}?`} text={UNBLOCK_EXPLAINED} action="Unblock"
          onConfirm={() => unblock(asking)} onClose={() => setAsking(null)} />
      )}
    </section>
  );
}
