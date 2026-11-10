"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";
import type { MatchRow } from "@/components/MatchBoard";

export default function MatchActions({ m }: { m: MatchRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: string, args: Record<string, unknown>) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc(fn, args);
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    router.refresh();
  }
  const primary = "rounded-xl bg-action py-3.5 font-medium text-white disabled:opacity-50";
  const secondary = "rounded-xl border border-grid bg-white py-3.5";
  return (
    <div className="flex flex-col gap-2">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      {m.i_organize ? (
        m.status === "open" ? (
          <>
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "closed" })} className={primary}>Close — I have my players</button>
            <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "cancelled" })} className="py-2 text-sm text-danger">Cancel the match</button>
          </>
        ) : m.status === "closed" ? (
          <button disabled={busy} onClick={() => run("set_match_status", { p_match: m.match_id, p_status: "open" })} className={secondary}>Reopen</button>
        ) : <p className="text-sm text-muted">Cancelled.</p>
      ) : m.i_joined ? (
        <button disabled={busy} onClick={() => run("leave_match", { p_match: m.match_id })} className={secondary}>Leave</button>
      ) : m.status === "open" ? (
        <button disabled={busy} onClick={() => run("join_match", { p_match: m.match_id })} className={primary}>Join</button>
      ) : <p className="text-sm text-muted">This match is {m.status}.</p>}
    </div>
  );
}
