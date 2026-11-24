import { createClient } from "@/lib/supabase/client";

/** One reservation, whichever way the club settles money.
 *
 *  'simulated'  hold the slot, then pay in the app  -> go to /pay/<booking>
 *  'at_desk'    confirmed on the spot, paid at the club -> go to /bookings/<booking>
 *  'fee_online' hold the slot, pay CourtBook's booking fee in the app -> /pay/<booking>; the court is paid at the
 *               club. A $0 fee is confirmed on the spot with no payment (hold_slot returns no payment) -> /bookings
 *
 *  The token makes a retry idempotent: the same token can only ever produce one booking, so a
 *  flaky connection or an impatient second tap cannot take two courts. It is generated once per
 *  attempt by the caller and reused if the caller retries that same attempt. */
export type Reserved = { bookingId: string; href: string };

export async function reserve(opts: {
  mode: string | null | undefined;
  clubId: string;
  courtId: string;
  start: Date;
  end: Date;
  token: string;
}): Promise<{ ok: true; value: Reserved } | { ok: false; message: string; code?: string }> {
  const supabase = createClient();
  if (opts.mode === "at_desk") {
    const { data, error } = await supabase.rpc("book_at_desk", {
      p_court: opts.courtId, p_start: opts.start.toISOString(), p_end: opts.end.toISOString(), p_token: opts.token,
    });
    if (error) return { ok: false, message: error.message, code: error.code };
    const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string };
    return { ok: true, value: { bookingId: row.booking_id, href: `/bookings/${row.booking_id}?new=1` } };
  }
  // the token goes to hold_slot too (since 0065): without it a retry after a lost answer would take a second hold
  const { data, error } = await supabase.rpc("hold_slot", {
    p_club: opts.clubId, p_court: opts.courtId, p_start: opts.start.toISOString(), p_end: opts.end.toISOString(), p_token: opts.token,
  });
  if (error) return { ok: false, message: error.message, code: error.code };
  const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string; payment_id: string | null };
  // no payment: a $0 fee at a fee_online club, confirmed already (0093)
  if (!row.payment_id) return { ok: true, value: { bookingId: row.booking_id, href: `/bookings/${row.booking_id}?new=1` } };
  return { ok: true, value: { bookingId: row.booking_id, href: `/pay/${row.booking_id}` } };
}

/** A fresh idempotency token for one reservation attempt. */
export const newToken = () => crypto.randomUUID();
