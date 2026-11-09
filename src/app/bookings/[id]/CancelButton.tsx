"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

export default function CancelButton({ bookingId, freeCancel, cutoffHours, cutoffLabel }: { bookingId: string; freeCancel: boolean; cutoffHours: number; cutoffLabel: string }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc("cancel_booking", { p_booking: bookingId, p_club_caused: false });
    if (error) { setBusy(false); setError(friendlyError(error.message)); return; }
    router.replace("/bookings");
    router.refresh();
  }

  if (!confirm) {
    return (
      <div className="mt-2 flex flex-col gap-1">
        <button onClick={() => setConfirm(true)} className="rounded-xl border border-danger/40 py-3.5 text-danger">Cancel booking</button>
        <p className="text-center text-xs text-muted">{freeCancel ? `Full refund if you cancel before ${cutoffLabel}.` : `Less than ${cutoffHours} h before start: no refund.`}</p>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-2xl bg-paper p-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      <p className="text-sm">{freeCancel ? "You will be refunded in full." : "This is inside the cutoff: the payment is not refunded."} Cancel this booking?</p>
      <button disabled={busy} onClick={cancel} className="rounded-xl bg-danger py-3 font-medium text-white disabled:opacity-50">{busy ? "Cancelling…" : "Yes, cancel"}</button>
      <button disabled={busy} onClick={() => setConfirm(false)} className="py-1 text-sm text-muted">Keep it</button>
    </div>
  );
}
