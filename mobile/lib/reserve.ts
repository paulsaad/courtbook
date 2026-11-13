import * as Crypto from "expo-crypto";
import { supabase } from "./supabase";
import { classify, type Failure } from "./errors";

/**
 * One reservation attempt, safe to retry.
 *
 * The attempt carries one token from start to finish. Every retry sends the same token, so the
 * database returns the booking the first call made (`already = true`) instead of making another or
 * replacing it — book_at_desk since 0051, hold_slot since 0065.
 *
 * Only a network failure is retried: the request may or may not have reached the server, and the
 * token makes asking again safe. A refusal (slot_taken, beyond_booking_window…) is final and is
 * returned at once. If the network never comes back, the result says "uncertain": the caller must
 * read the truth (my_active_hold / my bookings) rather than assume either outcome.
 */
export type Attempt = { token: string; mode: "at_desk" | "simulated" | string; clubId: string; courtId: string; start: Date; end: Date };
export type Reserved = { bookingId: string; paymentId: string | null; holdExpiresAt: string | null; already: boolean; confirmed: boolean };
export type ReserveResult =
  | { kind: "reserved"; value: Reserved }
  | { kind: "refused"; failure: Failure }
  | { kind: "uncertain"; failure: Failure };

export function newAttempt(a: Omit<Attempt, "token">): Attempt {
  return { ...a, token: Crypto.randomUUID() };
}

type Row = { booking_id: string; payment_id?: string | null; hold_expires_at?: string | null; already?: boolean | null };

async function callOnce(a: Attempt): Promise<{ data: Row | null; error: unknown }> {
  if (a.mode === "at_desk") {
    const { data, error } = await supabase.rpc("book_at_desk", {
      p_court: a.courtId, p_start: a.start.toISOString(), p_end: a.end.toISOString(), p_token: a.token,
    });
    const row = (Array.isArray(data) ? data[0] : data) as Row | null;
    return { data: row, error };
  }
  const { data, error } = await supabase.rpc("hold_slot", {
    p_club: a.clubId, p_court: a.courtId, p_start: a.start.toISOString(), p_end: a.end.toISOString(), p_token: a.token,
  });
  const row = (Array.isArray(data) ? data[0] : data) as Row | null;
  return { data: row, error };
}

export async function reserve(a: Attempt, opts: { attempts?: number; waitMs?: (n: number) => number } = {}): Promise<ReserveResult> {
  const attempts = opts.attempts ?? 3;
  const wait = opts.waitMs ?? ((n) => 600 * 2 ** n);
  let last: Failure = { kind: "unknown", message: "Something went wrong. Try again." };

  for (let n = 0; n < attempts; n++) {
    let data: Row | null = null;
    let error: unknown = null;
    try {
      ({ data, error } = await callOnce(a));
    } catch (thrown) {
      error = thrown; // fetch rejects outright when the connection drops
    }
    if (!error && data?.booking_id) {
      return {
        kind: "reserved",
        value: {
          bookingId: data.booking_id,
          paymentId: data.payment_id ?? null,
          holdExpiresAt: data.hold_expires_at ?? null,
          already: data.already === true,
          confirmed: a.mode === "at_desk",
        },
      };
    }
    last = classify(error ?? { message: "empty response" });
    if (last.kind !== "network") return { kind: "refused", failure: last };
    if (n < attempts - 1) await new Promise((r) => setTimeout(r, wait(n)));
  }
  return { kind: "uncertain", failure: last };
}
