import { createClient } from "@/lib/supabase/client";

/** One reservation, whichever way the club settles money.
 *
 *  'simulated'  hold the slot, then pay in the app  -> go to /pay/<booking>
 *  'at_desk'    confirmed on the spot, paid at the club -> go to /bookings/<booking>
 *
 *  The token makes a retry idempotent: the same token can only ever produce one booking, so a
 *  flaky connection or an impatient second tap cannot take two courts. It is generated once per
 *  attempt by the caller and reused if the caller retries that same attempt. */
export type Reserved = { bookingId: string; href: string };

/** The phone could not reach CourtBook (no connection, or it dropped). Chrome, Safari and Firefox wording. */
export const isNetworkFailure = (message: string | undefined) => /failed to fetch|load failed|networkerror|network request failed/i.test(message ?? "");
export const BOOKING_OFFLINE = "Couldn't reach CourtBook. Check your connection and try again.";
type Failed = { ok: false; message: string; code?: string; offline?: boolean };
const failed = (error: { message: string; code?: string }): Failed =>
  ({ ok: false, message: error.message, code: error.code, ...(isNetworkFailure(error.message) ? { offline: true } : {}) });

export async function reserve(opts: {
  mode: string | null | undefined;
  clubId: string;
  courtId: string;
  start: Date;
  end: Date;
  token: string;
}): Promise<{ ok: true; value: Reserved } | Failed> {
  const supabase = createClient();
  if (opts.mode === "at_desk") {
    const { data, error } = await supabase.rpc("book_at_desk", {
      p_court: opts.courtId, p_start: opts.start.toISOString(), p_end: opts.end.toISOString(), p_token: opts.token,
    });
    if (error) return failed(error);
    const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string };
    return { ok: true, value: { bookingId: row.booking_id, href: `/bookings/${row.booking_id}?new=1` } };
  }
  const { data, error } = await supabase.rpc("hold_slot", {
    p_club: opts.clubId, p_court: opts.courtId, p_start: opts.start.toISOString(), p_end: opts.end.toISOString(),
  });
  if (error) return failed(error);
  const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string };
  return { ok: true, value: { bookingId: row.booking_id, href: `/pay/${row.booking_id}` } };
}

/** A fresh idempotency token for one reservation attempt. */
export const newToken = () => crypto.randomUUID();
