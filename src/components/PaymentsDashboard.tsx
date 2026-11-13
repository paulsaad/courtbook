"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

export type Summary = { club_id: string; club_name: string; bookings: number; gross: number; fees: number; owed_to_club: number; refunds_due: number; refunded: number; simulated_bookings: number; simulated_total: number; simulated_refunds: number };
export type Balance = { club_id: string; club_name: string; club_share: number; paid_out: number; outstanding: number; simulated_share: number };
export type RefundRow = { payment_id: string; club_id: string; club_name: string; player_name: string | null; court_name: string | null; start_at: string; total_usd: number; note: string | null; since: string | null };
export type PaymentRow = { payment_id: string; status: string; player_name: string | null; court_name: string | null; start_at: string; amount_usd: number; fee_usd: number; total_usd: number; paid_at: string | null; provider_ref: string | null };

const usd = (n: number | string) => `$${Number(n).toFixed(2)}`;
const tz = "Asia/Beirut";

export default function PaymentsDashboard({ month, summary, refunds, rows, clubId, backHref, title, basePath, balances, isAdmin }: {
  month: string; summary: Summary[]; refunds: RefundRow[]; rows: PaymentRow[] | null; clubId: string | null; backHref: string; title: string; basePath: string;
  balances: Balance[]; isAdmin: boolean;
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
  // Money nobody actually paid. Kept apart from every figure above, and never added to them.
  const simulated = summary.reduce((a, s) => ({ n: a.n + Number(s.simulated_bookings ?? 0), total: a.total + Number(s.simulated_total ?? 0), r: a.r + Number(s.simulated_refunds ?? 0) }), { n: 0, total: 0, r: 0 });

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
        {(simulated.n > 0 || simulated.r > 0) && (
          <p className="mb-3 rounded-lg bg-slate-soft px-3 py-2 text-xs text-muted">
            <strong className="text-ink">Test money, not counted.</strong> {simulated.n} booking{simulated.n > 1 ? "s" : ""} worth {usd(simulated.total)} {simulated.n > 1 ? "were" : "was"} paid with a simulated provider. No money changed hands, so {simulated.n > 1 ? "they are" : "it is"} left out of every figure below.{simulated.r > 0 && ` ${simulated.r} cancelled simulated booking${simulated.r > 1 ? "s are" : " is"} not a refund anybody is owed.`}
          </p>
        )}
        <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-max text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="py-1">Club</th><th className="whitespace-nowrap pl-4 text-right">Paid bookings</th><th className="whitespace-nowrap pl-4 text-right">Collected</th><th className="whitespace-nowrap pl-4 text-right">CourtBook fees</th><th className="whitespace-nowrap pl-4 text-right">Club share</th></tr></thead>
          <tbody>
            {summary.map((s) => (
              <tr key={s.club_id} className="border-t border-grid">
                <td className="py-2">{s.club_name}{s.refunds_due > 0 && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs text-danger">{s.refunds_due} refund{s.refunds_due > 1 ? "s" : ""} due</span>}</td>
                <td className="whitespace-nowrap pl-4 text-right">{s.bookings}</td><td className="whitespace-nowrap pl-4 text-right">{usd(s.gross)}</td><td className="whitespace-nowrap pl-4 text-right font-medium text-turf">{usd(s.fees)}</td><td className="whitespace-nowrap pl-4 text-right">{usd(s.owed_to_club)}</td>
              </tr>
            ))}
            {summary.length > 1 && (
              <tr className="border-t border-grid font-medium"><td className="py-2">Total</td><td className="whitespace-nowrap pl-4 text-right">{totals.bookings}</td><td className="whitespace-nowrap pl-4 text-right">{usd(totals.gross)}</td><td className="whitespace-nowrap pl-4 text-right text-turf">{usd(totals.fees)}</td><td className="whitespace-nowrap pl-4 text-right">{usd(totals.owed)}</td></tr>
            )}
          </tbody>
        </table>
        </div>
        <p className="mt-2 text-xs text-muted">Money actually collected this month; refunded bookings and simulated payments excluded. Club share is before payouts — see balances below.</p>
      </section>

      <section className="rounded-2xl border border-grid bg-white p-4">
        <h2 className="mb-2 font-medium">Club balances (all time)</h2>
        <div className="-mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-max text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="py-1">Club</th><th className="whitespace-nowrap pl-4 text-right">Club share</th><th className="whitespace-nowrap pl-4 text-right">Paid out</th><th className="whitespace-nowrap pl-4 text-right">Outstanding</th></tr></thead>
          <tbody>
            {balances.map((b) => (
              <tr key={b.club_id} className="border-t border-grid">
                <td className="py-2">{b.club_name}</td><td className="whitespace-nowrap pl-4 text-right">{usd(b.club_share)}</td><td className="whitespace-nowrap pl-4 text-right">{usd(b.paid_out)}</td>
                <td className={`whitespace-nowrap pl-4 text-right font-medium ${Number(b.outstanding) > 0 ? "text-danger" : ""}`}>
                  {usd(b.outstanding)}
                  {/* Negative means CourtBook paid out more than it collected — the opposite of a debt
                      to the club, and a red number alone would read as exactly that. */}
                  {Number(b.outstanding) < 0 && <span className="ml-1 text-xs font-normal text-muted">overpaid</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {balances.some((b) => Number(b.simulated_share ?? 0) > 0) && (
          <p className="mt-3 rounded-lg bg-slate-soft px-3 py-2 text-xs text-muted">
            An outstanding balance means CourtBook is holding this club&apos;s money. Simulated bookings are excluded, so a club that has only test bookings is owed nothing.
          </p>
        )}
        {isAdmin && clubId && <PayoutForm clubId={clubId} />}
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

function PayoutForm({ clubId }: { clubId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("Whish");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    // Through the function, not into the table: only the server knows what this club is owed, and
    // only the server should decide who the payout is recorded against.
    const { error } = await createClient().rpc("record_club_payout", {
      p_club: clubId, p_amount: Number(amount), p_method: method, p_reference: reference.trim() || null,
    });
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    setAmount(""); setReference("");
    router.refresh();
  }
  return (
    <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2 border-t border-grid pt-3 text-sm">
      <label className="flex flex-col gap-1">Record payout ($)<input className="w-28 rounded-lg border border-grid px-3 py-2" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="flex flex-col gap-1">Method<select className="rounded-lg border border-grid px-3 py-2" value={method} onChange={(e) => setMethod(e.target.value)}><option>Whish</option><option>Cash</option><option>Bank</option></select></label>
      <label className="flex flex-1 flex-col gap-1">Reference<input className="rounded-lg border border-grid px-3 py-2" value={reference} onChange={(e) => setReference(e.target.value)} /></label>
      <button disabled={busy} className="rounded-lg bg-action px-4 py-2 font-medium text-white disabled:opacity-50">Save</button>
      {error && <p className="w-full text-danger">{error}</p>}
    </form>
  );
}
