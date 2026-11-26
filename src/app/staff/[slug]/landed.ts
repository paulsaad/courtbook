/**
 * R1 (Session B's release validation, Paul 26 Nov: staff must not be left uncertain whether it succeeded).
 * After a desk action fails — no answer (lost connection) or a refusal that may come from the desk's own earlier try
 * whose answer was lost — the calendar reads whether the action's RESULT is now in the database:
 *   true  = a matching result is there. It may be this request's, an earlier try's, or ANOTHER staff member's doing
 *           the same thing (Paul's review of #98): there is no request id to tell them apart, so the desk is shown what
 *           the calendar now holds and is never told that this request succeeded;
 *   false = no matching result yet. After a refusal, the refusal stands. After no answer, it is NOT proof that the
 *           request will never be saved (it may still commit): the desk is told it could not be confirmed;
 *   null  = could not check (still no connection).
 * Each check is one small read under the staff's own row-level security; nothing is written.
 */
type Res = { data: unknown; error: unknown };
type Q = { eq: (c: string, v: unknown) => Q; maybeSingle: () => PromiseLike<Res> };
export type Reader = { from: (t: "bookings" | "blocks") => { select: (c: string) => Q } };

const one = async (q: Q): Promise<boolean | null> => {
  const { data, error } = await q.maybeSingle();
  return error ? null : data != null;
};

export const landed = {
  /** staff_book: the walk-in this desk entered, on that court at that start */
  walkIn: (db: Reader, courtId: string, startIso: string, endIso: string, name: string) =>
    one(db.from("bookings").select("id").eq("court_id", courtId).eq("start_at", startIso).eq("end_at", endIso)
      .eq("status", "confirmed").eq("source", "staff").eq("guest_name", name.trim())),
  /** staff_block: a block on that court with exactly that interval */
  block: (db: Reader, courtId: string, startIso: string, endIso: string) =>
    one(db.from("blocks").select("id").eq("court_id", courtId).eq("start_at", startIso).eq("end_at", endIso)),
  /** move_booking_priced: the booking now on the target court and time */
  moved: (db: Reader, bookingId: string, courtId: string, startIso: string, endIso: string) =>
    one(db.from("bookings").select("id").eq("id", bookingId).eq("court_id", courtId).eq("start_at", startIso).eq("end_at", endIso).eq("status", "confirmed")),
  /** cancel_booking / mark_no_show: the booking has that status now */
  status: (db: Reader, bookingId: string, status: "cancelled" | "no_show") =>
    one(db.from("bookings").select("id").eq("id", bookingId).eq("status", status)),
  /** removing a block: it is gone */
  blockGone: async (db: Reader, blockId: string) => {
    const r = await one(db.from("blocks").select("id").eq("id", blockId));
    return r === null ? null : !r;
  },
};

/** No answer, and no matching result found yet: uncertain, never "not saved" (Paul's review of #98, correction B). */
export const DESK_UNCONFIRMED = "Couldn't confirm whether this was saved. Check the calendar before trying again.";
/** No answer, and the calendar could not be checked either. */
export const DESK_UNREACHABLE = "Couldn't reach CourtBook. Your action may have been saved. Check the calendar when the connection returns before trying again.";
/** A matching result is in the calendar, but it cannot be attributed to this request (correction A): say what is there. */
export const deskStateShown = (what: string) => `Couldn't confirm this request, but the calendar now shows ${what}. Check it before doing anything else.`;
