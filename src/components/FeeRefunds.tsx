"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

/** One CourtBook booking fee owed back (fee_refunds_due, 0094). Admin only: the database refuses anyone else. */
export type FeeRefundRow = {
  charge_id: string; club_name: string | null; provider: string; provider_ref: string; amount: number | string; currency: string;
  reason: string; since: string; court_name: string | null; start_at: string | null;
};

const REASON: Record<string, string> = {
  club_cancelled: "club cancelled", not_confirmed: "paid after the hold ended", duplicate: "paid twice",
  wrong_amount: "wrong amount", wrong_currency: "wrong currency", unmatched: "not matched to any booking",
  extra_charge: "charged again on the same payment",
};

/**
 * CourtBook's own refunds (M12.1). The admin refunds the player in the provider's portal first, then records it here
 * with the provider's refund reference. The amount must be exactly what was charged; one reference settles one charge.
 */
export default function FeeRefunds({ rows }: { rows: FeeRefundRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function complete(r: FeeRefundRow) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc("complete_fee_refund", { p_charge: r.charge_id, p_amount: Number(r.amount), p_method: "provider_portal", p_reference: reference.trim() });
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    setOpen(null); setReference("");
    router.refresh();
  }

  return (
    <section className="rounded-2xl border border-grid bg-white p-4">
      <h2 className="mb-1 font-medium">CourtBook booking fees to refund {rows.length > 0 && <span className="text-danger">({rows.length})</span>}</h2>
      <p className="mb-2 text-xs text-muted">Refund the player in the provider&apos;s portal first, then record the provider&apos;s refund reference here. Clubs never see or handle these.</p>
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      {rows.length === 0 ? <p className="text-sm text-muted">None.</p> : (
        <ul className="divide-y divide-grid">
          {rows.map((r) => (
            <li key={r.charge_id} className="flex flex-col gap-2 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{Number(r.amount).toFixed(2)} {r.currency} · {REASON[r.reason] ?? r.reason}</div>
                  <div className="text-xs text-muted">
                    {r.provider} ref {r.provider_ref}{r.club_name ? ` · ${r.club_name}` : ""}{r.court_name ? ` · ${r.court_name}` : ""}
                    {r.start_at ? ` · ${formatInTimeZone(new Date(r.start_at), "Asia/Beirut", "EEE d MMM HH:mm")}` : ""} · owed since {formatInTimeZone(new Date(r.since), "Asia/Beirut", "d MMM HH:mm")}
                  </div>
                </div>
                {open !== r.charge_id && <button disabled={busy} onClick={() => { setOpen(r.charge_id); setReference(""); setError(null); }} className="shrink-0 rounded-lg border border-grid px-3 py-1.5">Record refund</button>}
              </div>
              {open === r.charge_id && (
                <div className="flex flex-wrap items-center gap-2">
                  <input aria-label="Provider refund reference" placeholder="Provider refund reference" value={reference} onChange={(e) => setReference(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-grid px-3 py-1.5" />
                  <button disabled={busy || !reference.trim()} onClick={() => complete(r)} className="rounded-lg bg-action px-3 py-1.5 text-white disabled:opacity-50">Refunded {Number(r.amount).toFixed(2)} {r.currency}</button>
                  <button disabled={busy} onClick={() => setOpen(null)} className="text-muted">Cancel</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
