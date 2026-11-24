"use client";

import { friendlyError } from "@/lib/types";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { hhmm } from "@/lib/time";

type Props = {
  bookingId: string; paymentId: string; status: string;
  clubName: string; clubSlug: string; timezone: string; courtName: string;
  startAt: string; endAt: string; holdExpiresAt: string | null;
  price: number; fee: number; total: number;
  /** fee_online club (M12.1): only the booking fee is paid here; the court is paid at the club */
  feeOnly?: boolean; simulated?: boolean;
  lastAttempt?: { status: string; outcome: string | null } | null; attemptsLeft?: number;
};

/** What the latest fee attempt came to, in the player's words (null: nothing worth saying). */
export function attemptNotice(a: Props["lastAttempt"], left: number): string | null {
  if (!a) return null;
  const again = left > 0 ? ` You can try again (${left} ${left === 1 ? "try" : "tries"} left).` : " No tries left for this hold: pick the slot again if it is still free.";
  if (a.status === "failed" || a.status === "expired") return `That payment did not go through.${again}`;
  if (a.status === "starting" || a.status === "open") return "Waiting for the payment provider to confirm. If you paid, this page will update — reload it in a moment.";
  if (a.status === "succeeded" && a.outcome && a.outcome !== "confirmed") return `We received a payment we could not use for this booking. It will be refunded in full.${again}`;
  return null;
}

export default function PayPanel(p: Props) {
  const router = useRouter();
  // one key per tap: a retry of the same tap (lost answer) reuses it and gets the same attempt, never a second charge
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!p.holdExpiresAt) return;
    const end = new Date(p.holdExpiresAt).getTime();
    const tick = () => setLeft(Math.max(0, Math.floor((end - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [p.holdExpiresAt]);

  const expired = p.status !== "pending" || left === 0;

  async function payFee() {
    setBusy(true); setError(null);
    const key = requestKey ?? crypto.randomUUID();
    setRequestKey(key);
    let res: Response;
    try {
      res = await fetch("/api/pay/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentId: p.paymentId, requestKey: key }) });
    } catch {
      setBusy(false); setError("No connection. Tap Pay again: you will not be charged twice."); return;
    }
    const json = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string; redirect?: string; state?: string };
    if (json.redirect) { window.location.href = json.redirect; return; }
    setRequestKey(null);                                   // this tap is finished: the next tap is a new attempt
    if (json.outcome === "confirmed" || json.outcome === "already_recorded") { router.replace(`/bookings/${p.bookingId}?new=1`); return; }
    setBusy(false);
    if (!res.ok) { setError(friendlyError(json.error ?? "Payment failed.")); router.refresh(); return; }
    router.refresh();                                      // shows what happened to this attempt (attemptNotice)
  }

  async function pay() {
    if (p.feeOnly) return payFee();
    setBusy(true); setError(null);
    const res = await fetch("/api/pay/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentId: p.paymentId }) });
    const json = (await res.json()) as { outcome?: string; error?: string; redirect?: string };
    if (!res.ok) { setBusy(false); setError(friendlyError(json.error ?? "Payment failed.")); return; }
    if (json.redirect) { window.location.href = json.redirect; return; }
    if (json.outcome === "confirmed" || json.outcome === "already_paid") { router.replace(`/bookings/${p.bookingId}?new=1`); return; }
    setBusy(false);
    setError("The slot was released before the payment completed. You will be refunded.");
  }

  async function giveUp() {
    setBusy(true);
    await createClient().rpc("release_hold", { p_booking: p.bookingId });
    router.replace(`/club/${p.clubSlug}`);
  }

  const day = formatInTimeZone(new Date(p.startAt), p.timezone, "EEEE d MMMM");

  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-5 p-5">
      <Link href={`/club/${p.clubSlug}`} className="text-sm text-muted">‹ {p.clubName}</Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Confirm and pay</h1>
        <p className="mt-1 text-muted">{p.courtName} · {day}, {hhmm(p.startAt, p.timezone)}–{hhmm(p.endAt, p.timezone)}</p>
      </div>

      {p.feeOnly ? (
        <div className="rounded-2xl border border-grid bg-white p-4 text-sm">
          <div className="flex justify-between py-1"><span>Court — pay at the club</span><span>${p.price.toFixed(2)}</span></div>
          <div className="mt-2 flex justify-between border-t border-grid pt-3 text-base font-semibold"><span>CourtBook booking fee — pay now</span><span>${p.fee.toFixed(2)}</span></div>
          <p className="mt-2 text-xs text-muted">The booking fee is not refunded if you cancel. It is refunded if the club cancels or the booking can&apos;t be confirmed.</p>
        </div>
      ) : (
      <div className="rounded-2xl border border-grid bg-white p-4 text-sm">
        <div className="flex justify-between py-1"><span>Court</span><span>${p.price.toFixed(2)}</span></div>
        <div className="flex justify-between py-1"><span>Booking fee</span><span>${p.fee.toFixed(2)}</span></div>
        <div className="mt-2 flex justify-between border-t border-grid pt-3 text-base font-semibold"><span>Total</span><span>${p.total.toFixed(2)}</span></div>
      </div>
      )}
      {p.feeOnly && !error && attemptNotice(p.lastAttempt ?? null, p.attemptsLeft ?? 0) && (
        <p className="rounded-lg bg-paper px-3 py-2 text-sm">{attemptNotice(p.lastAttempt ?? null, p.attemptsLeft ?? 0)}</p>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}

      {expired ? (
        <>
          <p className="rounded-xl bg-paper p-4 text-sm">This hold has expired. Pick the slot again if it is still free.</p>
          <Link href={`/club/${p.clubSlug}`} className="rounded-xl bg-action py-3.5 text-center font-medium text-white">Back to courts</Link>
        </>
      ) : (
        <>
          <button disabled={busy || (p.feeOnly && (p.attemptsLeft ?? 0) <= 0)} onClick={pay} className="rounded-xl bg-action py-3.5 text-base font-medium text-white disabled:opacity-50">
            {busy ? "Paying…" : p.feeOnly ? `Pay the $${p.fee.toFixed(2)} booking fee` : `Pay $${p.total.toFixed(2)}`}
          </button>
          <p className="text-center text-xs text-muted">
            {p.feeOnly && !p.simulated ? "" : "Test mode: no money is taken. "}Slot held for {left !== null ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "…"}.
          </p>
          <button disabled={busy} onClick={giveUp} className="rounded-xl border border-grid bg-white py-3 text-base">Cancel and release the slot</button>
        </>
      )}
    </main>
  );
}
