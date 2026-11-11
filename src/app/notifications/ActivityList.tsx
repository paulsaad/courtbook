"use client";

import Link from "next/link";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";

export type Note = { id: string; kind: string; match_id: string | null; body: string; created_at: string; read_at: string | null };

/** Activity with per-item delete and "Clear all". Only your own items — nobody else's activity is touched. */
export default function ActivityList({ initial }: { initial: Note[] }) {
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  async function remove(id: string) {
    setRows((r) => r.filter((x) => x.id !== id));                       // optimistic
    const { error } = await createClient().rpc("delete_notification", { p_id: id });
    if (error) setRows(initial);
  }
  async function clearAll() {
    setBusy(true);
    const { error } = await createClient().rpc("clear_notifications");
    setBusy(false); setConfirmClear(false);
    if (!error) setRows([]);
  }

  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="text-[26px] font-extrabold tracking-tight">Activity</h1>
        {rows.length > 0 && (confirmClear
          ? <span className="flex gap-3 text-sm"><button disabled={busy} onClick={clearAll} className="font-semibold text-cedar">Clear all</button><button onClick={() => setConfirmClear(false)} className="text-muted">Cancel</button></span>
          : <button onClick={() => setConfirmClear(true)} className="text-sm text-muted">Clear all</button>)}
      </div>
      <ul className="card divide-y divide-grid overflow-hidden">
        {rows.length === 0 && <li className="p-6 text-center text-sm text-muted">Nothing here. Join requests, messages and match changes show up on this screen. <Link href="/play" className="font-semibold text-turf">Find a game</Link></li>}
        {rows.map((n) => (
          <li key={n.id} className="flex items-start">
            <Link href={n.match_id ? `/matches/${n.match_id}` : "/"} className={`flex min-w-0 flex-1 items-start gap-3 px-4 py-3 ${n.read_at ? "" : "bg-turf-soft/40"}`}>
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-turf" style={{ opacity: n.read_at ? 0 : 1 }} />
              <span className="min-w-0 flex-1"><span className="block text-sm">{n.body}</span><span className="block text-xs text-muted">{formatInTimeZone(new Date(n.created_at), "Asia/Beirut", "EEE d MMM HH:mm")}</span></span>
            </Link>
            <button onClick={() => remove(n.id)} aria-label="Delete this item" className="px-4 py-4 text-muted">✕</button>
          </li>
        ))}
      </ul>
    </>
  );
}
