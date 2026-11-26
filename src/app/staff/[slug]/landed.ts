/**
 * R1 (Session B's release validation, Paul 26 Nov: staff must not be left uncertain whether it succeeded).
 * After a desk action fails — no answer (lost connection) or a refusal that may come from the desk's own earlier try
 * whose answer was lost — the calendar reads whether the action's own result is now in the database:
 *   true  = it is there (the earlier try was saved): show it as done, never as "taken" or "no longer active";
 *   false = it is not there: the refusal (or "not saved") stands;
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

/** What the desk is told when the action got no answer: after the check, never "Something went wrong". */
export const DESK_NOT_SAVED = "Couldn't reach CourtBook. The calendar has been checked: this was not saved. Try again.";
export const DESK_UNCHECKED = "Couldn't reach CourtBook. It may have been saved: when the connection is back, check the calendar before trying again.";
