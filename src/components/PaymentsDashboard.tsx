"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

export type Summary = { club_id: string; club_name: string; bookings: number; gross: number; fees: number; owed_to_club: number; refunds_due: number; refunded: number };
export type RefundRow = { payment_id: string; club_name: string; player_name: string | null; court_name: string | null; start_at: string; total_usd: number; note: string | null; since: string | null };
export type PaymentRow = { payment_id: string; status: string; player_name: string | null; court_name: string | null; start_at: string; amount_usd: number; fee_usd: number; total_usd: number; paid_at: string | null; provider_ref: string | null };

const usd = (n: number | string) => `$${Number(n).toFixed(2)}`;
const tz = "Asia/Beirut";

export default function PaymentsDashboard({ month, summary, refunds, rows, clubId, backHref, title, basePath }: {
  month: string; summary: Summary[]; refunds: RefundRow[]; rows: PaymentRow[] | null; clubId: string | null; backHref: string; title: string; basePath: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markRefunded(id: string) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc("mark_refunded", { p_payment: id });
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    router.refresh();
  }
  const shift = (d: number) => { const [y, m] = month.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1 + d, 1)); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`; };
  const monthLabel = formatInTimeZone(new Date(`${month}-15T00:00:00Z`), "UTC", "MMMM yyyy");
  const totals = summary.reduce((a, s) => ({ bookings: a.bookings + s.bookings, gross: a.gross + Number(s.gross), fees: a.fees + Number(s.fees), owed: a.owed + Number(s.owed_to_club) }), { bookings: 0, gross: 0, fees: 0, owed: 0 });

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-5 p-5 pb-16">
      <Link href={backHref} className="text-sm text-muted">‹ Back</Link>
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="flex items-center gap-1">
          <Link href={`${basePath}?month=${shift(-1)}`} className="grid h-9 w-9 place-items-center rounded-full border border-grid bg-white">‹</Link>
          <span className="w-36 text-center text-sm font-medium">{monthLabel}</span>
          <Link href={`${basePath}?month=${shift(1)}`} className="grid h-9 w-9 place-items-center rounded-full border border-grid bg-white">›</Link>
        </div>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}

      <section className="rounded-2xl border border-grid bg-white p-4">
        <h2 className="mb-3 font-medium">Month summary</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="py-1">Club</th><th className="text-right">Paid bookings</th><th className="text-right">Collected</th><th className="text-right">CourtBook fees</th><th className="text-right">Owed to club</th></tr></thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.club_id} className="border-t border-grid">
                <td className="py-2">{s.club_name}{s.refunds_due > 0 && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs text-danger">{s.refunds_due} refund{s.refunds_due > 1 ? "s" : ""} due</span>}</td>
                <td className="text-right">{s.bookings}</td><td className="text-right">{usd(s.gross)}</td><td className="text-right font-medium text-turf">{usd(s.fees)}</td><td className="text-right">{usd(s.owed_to_club)}</td>
              </tr>
            ))}
            {summary.length > 1 && (
              <tr className="border-t border-grid font-medium"><td className="py-2">Total</td><td className="text-right">{totals.bookings}</td><td className="text-right">{usd(totals.gross)}</td><td className="text-right text-turf">{usd(totals.fees)}</td><td className="text-right">{usd(totals.owed)}</td></tr>
            )}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">Counts payments with status paid. Refunded bookings are excluded. Payouts to clubs are manual in v0.1 (test mode: no real money).</p>
      </section>

      <section className="rounded-2xl border border-grid bg-white p-4">
        <h2 className="mb-2 font-medium">Refunds due {refunds.length > 0 && <span className="text-danger">({refunds.length})</span>}</h2>
        {refunds.length === 0 ? <p className="text-sm text-muted">None.</p> : (
          <ul className="divide-y divide-grid">
            {refunds.map((r) => (
              <li key={r.payment_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{usd(r.total_usd)} to {r.player_name ?? "player"}</div>
                  <div className="text-xs text-muted">{r.club_name} · {r.court_name} · {formatInTimeZone(new Date(r.start_at), tz, "EEE d MMM HH:mm")} · {r.note}</div>
                </div>
                <button disabled={busy} onClick={() => markRefunded(r.payment_id)} className="shrink-0 rounded-lg border border-grid px-3 py-1.5">Mark refunded</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {rows && clubId && (
        <section className="rounded-2xl border border-grid bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-medium">Payments</h2>
            <a href={`/api/payments.csv?club=${clubId}&month=${month}`} className="text-sm text-action underline">Download CSV</a>
          </div>
          {rows.length === 0 ? <p className="text-sm text-muted">No payments this month.</p> : (
            <ul className="divide-y divide-grid text-sm">
              {rows.map((p) => (
                <li key={p.payment_id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <div>{p.player_name ?? "player"} · {p.court_name} · {formatInTimeZone(new Date(p.start_at), tz, "EEE d MMM HH:mm")}</div>
                    <div className="text-xs text-muted">{usd(p.amount_usd)} + {usd(p.fee_usd)} fee · {p.provider_ref ?? "—"}</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${p.status === "paid" ? "bg-turf-soft text-turf" : p.status === "refund_due" ? "bg-red-50 text-danger" : "bg-slate-soft text-muted"}`}>{p.status.replace("_", " ")}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
