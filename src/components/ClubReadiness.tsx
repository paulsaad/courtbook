"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

/** M8 (0081): what the database says this club still needs before players can see and book it. */
export type ReadinessRow = { item: string; ok: boolean; detail: string | null };
const LABEL: Record<string, string> = {
  name: "Name", location: "Town and address (or map link)", contact: "Contact phone", hours: "Opening hours",
  courts: "Courts", prices: "A price for every court, day and start time", prices_unambiguous: "No overlapping prices",
  staff: "A desk account (staff)", payment: "Payment at the desk",
};

export default function ClubReadiness({ clubId, active, rows, isAdmin }: { clubId: string; active: boolean; rows: ReadinessRow[]; isAdmin: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = rows.length > 0 && rows.every((r) => r.ok);
  async function setVisible(v: boolean) {
    setBusy(true); setError(null);
    const { data, error } = await createClient().from("clubs").update({ active: v }).eq("id", clubId).select("id");
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    if (!data?.length) { setError("Only an admin can change this."); return; }
    router.refresh();
  }
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-grid bg-white p-4" aria-labelledby="readiness">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="readiness" className="font-medium">Ready for players?</h2>
        <span className={`text-sm font-semibold ${active ? "text-turf" : "text-muted"}`}>{active ? "Visible to players" : "Hidden from players"}</span>
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        {rows.map((r) => (
          <li key={r.item} className="flex gap-2">
            <span aria-hidden className={r.ok ? "text-turf" : "text-danger"}>{r.ok ? "✓" : "✗"}</span>
            <span><span className="sr-only">{r.ok ? "Done: " : "Missing: "}</span>{LABEL[r.item] ?? r.item}{r.detail ? <span className="text-muted"> — {r.detail}</span> : null}</span>
          </li>
        ))}
      </ul>
      {active && !ready && <p className="text-sm text-danger">This club is visible but incomplete: players may not be able to book some times.</p>}
      {isAdmin ? (
        active
          ? <button disabled={busy} onClick={() => setVisible(false)} className="rounded-xl border border-grid px-4 py-2.5 font-medium disabled:opacity-50">Hide from players</button>
          : <button disabled={busy || !ready} onClick={() => setVisible(true)} className="rounded-xl bg-action px-4 py-2.5 font-medium text-white disabled:opacity-50">{ready ? "Publish to players" : "Publish (finish the checklist first)"}</button>
      ) : (
        !active && <p className="text-sm text-muted">When everything is ticked, CourtBook publishes the club.</p>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </section>
  );
}
