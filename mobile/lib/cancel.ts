import { useCallback, useEffect, useRef, useState } from "react";
import { onlineManager } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { classify } from "./errors";
import { limited } from "./reserve";

export type CancelPhase = "idle" | "sending" | "uncertain" | "checking";

export const CANCEL_MESSAGES = {
  offline: "You're offline, so nothing was sent. Your booking is unchanged.",
  uncertain: "We couldn't confirm the cancellation yet. We'll check your booking as soon as you're back online.",
  checking: "Checking your booking…",
  stillActive: "Your booking is still active — it was not cancelled. You can try again.",
} as const;

/**
 * Cancelling a booking when the connection may drop. cancel_booking decides (refund, cutoff); the
 * phone only asks. If no answer comes back, the booking is re-read and the screen shows whatever
 * status the database has — never "cancelled" because we asked, never "still booked" because we
 * timed out. `read` re-reads the booking: its status, or "unreachable".
 */
export function useCancellation({ bookingId, read }: { bookingId: string; read: () => Promise<string | null | "unreachable"> }) {
  const [phase, setPhase] = useState<CancelPhase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const phaseRef = useRef<CancelPhase>("idle");
  const go = (p: CancelPhase) => { phaseRef.current = p; setPhase(p); };
  const readRef = useRef(read);
  readRef.current = read;

  const check = useCallback(async () => {
    if (phaseRef.current === "checking") return;
    go("checking");
    setProblem(CANCEL_MESSAGES.checking);
    const status = await readRef.current();
    if (status === "unreachable") {
      setProblem(CANCEL_MESSAGES.uncertain);
      return go("uncertain");
    }
    setProblem(status === "confirmed" ? CANCEL_MESSAGES.stillActive : null);
    go("idle");
  }, []);

  const submit = useCallback(async () => {
    if (phaseRef.current !== "idle") return;
    if (!onlineManager.isOnline()) {
      setProblem(CANCEL_MESSAGES.offline);
      return;
    }
    go("sending");
    setProblem(null);
    let error: unknown = null;
    try {
      ({ error } = await limited(supabase.rpc("cancel_booking", { p_booking: bookingId, p_club_caused: false })));
    } catch (thrown) {
      error = thrown;
    }
    if (!error) {
      go("idle");
      void readRef.current();
      return;
    }
    const f = classify(error);
    if (f.kind === "refused" && f.reason === "not_confirmed") {
      // Already not active — most likely an earlier attempt of ours did go through. Show the truth.
      go("idle");
      return void check();
    }
    if (f.kind === "refused" || f.kind === "auth") {
      setProblem(f.message);
      return go("idle");
    }
    setProblem(CANCEL_MESSAGES.uncertain);
    go("uncertain");
    if (onlineManager.isOnline()) void check();
  }, [bookingId, check]);

  useEffect(
    () => onlineManager.subscribe((online) => {
      if (online && phaseRef.current === "uncertain") void check();
    }),
    [check],
  );

  return { phase, problem, submit, check };
}
