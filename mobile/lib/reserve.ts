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
 * Only a named refusal from the database (slot_taken, beyond_booking_window…) or a rejected session
 * is final. Anything else — no connection, a timeout, a gateway error, an answer we cannot read —
 * may have happened after the database committed, so it is retried with the same token, and if
 * that never gets an answer the result is "uncertain": the caller reads the truth with
 * findByToken() rather than assume either outcome. A timeout never means "failed".
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

/** Every call gives up waiting after this long and is treated as "no answer" — never as a refusal. */
export const CALL_TIMEOUT_MS = 20_000;

/** Await a supabase-js builder (rpc or select) with a time limit. */
export async function limited<R>(builder: PromiseLike<R>): Promise<R> {
  const b = builder as PromiseLike<R> & { abortSignal?: (s: AbortSignal) => PromiseLike<R> };
  if (typeof b.abortSignal !== "function") return await builder;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  try {
    return await b.abortSignal(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

type Row = { booking_id: string; payment_id?: string | null; hold_expires_at?: string | null; already?: boolean | null };

async function callOnce(a: Attempt): Promise<{ data: Row | null; error: unknown }> {
  if (a.mode === "at_desk") {
    const { data, error } = await limited(supabase.rpc("book_at_desk", {
      p_court: a.courtId, p_start: a.start.toISOString(), p_end: a.end.toISOString(), p_token: a.token,
    }));
    const row = (Array.isArray(data) ? data[0] : data) as Row | null;
    return { data: row, error };
  }
  const { data, error } = await limited(supabase.rpc("hold_slot", {
    p_club: a.clubId, p_court: a.courtId, p_start: a.start.toISOString(), p_end: a.end.toISOString(), p_token: a.token,
  }));
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
    if (last.kind === "refused" || last.kind === "auth") return { kind: "refused", failure: last };
    if (n < attempts - 1) await new Promise((r) => setTimeout(r, wait(n)));
  }
  return { kind: "uncertain", failure: last };
}

export type Lookup =
  | { kind: "found"; bookingId: string; status: string }
  | { kind: "absent" }
  | { kind: "unreachable" };

/**
 * Did the attempt with this token create a booking? Reads the player's own bookings (row-level
 * security) by the token the attempt sent. "absent" is an answer from the database; "unreachable"
 * means we still do not know.
 */
export async function findByToken(token: string): Promise<Lookup> {
  try {
    const { data, error } = await limited(supabase.from("bookings").select("id, status").eq("client_token", token).maybeSingle());
    if (error) return { kind: "unreachable" };
    const row = data as { id: string; status: string } | null;
    return row ? { kind: "found", bookingId: row.id, status: row.status } : { kind: "absent" };
  } catch {
    return { kind: "unreachable" };
  }
}
