import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { MESSAGES, reservations, type Phase, type Selection, type SubmitResult } from "./pendingReservation";

export { MESSAGES, type Phase, type Selection } from "./pendingReservation";

/**
 * A club screen's view of the player's reservation. The attempt itself lives in the app-wide store
 * (pendingReservation.ts), so it outlives this screen; this hook only decides what the screen shows:
 *   - an unresolved attempt at this club → locked, showing exactly what was sent;
 *   - an unresolved attempt at another club → `blockedBy`: nothing can be reserved here until then;
 *   - an attempt at this club that just ended → the booking opens, or the reason is shown.
 */
export function useReservation({ clubId, onReserved }: { clubId: string | null; onReserved: (bookingId: string, status: string) => void }) {
  const store = reservations();
  const s = useSyncExternalStore(store.subscribe, store.getState);
  const mine = s.pending && s.userId && s.pending.userId === s.userId ? s.pending : null;
  const here = !!mine && !!clubId && mine.sel.clubId === clubId;
  const phase: Phase = here ? s.phase : "idle";

  const reserved = useRef(onReserved);
  reserved.current = onReserved;
  // A booking made from this club's screen opens its confirmation here; one that resolves while the
  // player is elsewhere is announced by the banner instead.
  useEffect(() => {
    const o = s.outcome;
    if (o?.kind === "booked" && clubId && o.sel.clubId === clubId && o.userId === s.userId) {
      store.acknowledge();
      reserved.current(o.bookingId, o.status);
    }
  }, [s.outcome, s.userId, clubId, store]);

  // Whatever this screen said about how the last attempt ended was seen here; not repeated elsewhere.
  useEffect(() => () => { if (clubId) store.dismiss(clubId); }, [clubId, store]);

  const ended = s.outcome?.kind === "not-booked" && s.outcome.sel.clubId === clubId && s.outcome.userId === s.userId ? s.outcome.message : null;
  const notice = s.notice?.clubId === clubId ? s.notice.message : null;
  const problem = here ? s.note : mine ? MESSAGES.blocked : ended ?? notice;

  const submit = useCallback((sel: Selection): Promise<SubmitResult> => store.submit(sel), [store]);
  const check = useCallback(() => store.check(), [store]);

  return {
    phase,
    /** While this club's reservation is in flight or unconfirmed, nothing the player sent can change. */
    locked: phase !== "idle",
    /** What was sent, while it is unresolved. */
    pending: here ? mine.sel : null,
    /** An unresolved reservation at another club: nothing can be reserved here until it is settled. */
    blockedBy: mine && !here ? mine.sel : null,
    problem,
    submit,
    check,
    clearProblem: () => { if (clubId && !here) store.dismiss(clubId); },
  };
}
