import { useCallback, useEffect, useRef, useState } from "react";
import { onlineManager } from "@tanstack/react-query";
import { findByToken, newAttempt, reserve, type Attempt } from "./reserve";

/** What the player asked for, frozen at the moment they tapped Reserve. */
export type Selection = {
  key: string; // court|start|minutes — a different key is a different reservation
  mode: string;
  clubId: string;
  courtId: string;
  courtName: string;
  date: string;
  start: string;
  minutes: number;
  price: number | null;
};

/**
 * idle      — nothing in flight; the selection can change.
 * sending   — the request (and its automatic retries) are in flight.
 * uncertain — no answer: the booking may or may not exist. Checked as soon as we are online.
 * checking  — reading the database for the attempt's token.
 * While not idle the selection is locked and the panel shows `pending`, the selection that was sent.
 */
export type Phase = "idle" | "sending" | "uncertain" | "checking";

export const MESSAGES = {
  offline: "You're offline, so nothing was sent. Reserve again when you're back online.",
  uncertain: "We couldn't confirm your booking yet. We'll check as soon as you're back online.",
  checking: "Checking whether your booking went through…",
  absent: "Your booking didn't go through — nothing was reserved. You can try again.",
} as const;

export function useReservation({ onReserved }: { onReserved: (bookingId: string, status: string) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<Selection | null>(null);
  // The attempt and its token outlive a failure: asking again for the same selection reuses the
  // token, so a request that did reach the database is returned instead of being made twice.
  const attempt = useRef<{ sel: Selection; a: Attempt } | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const busy = useRef(false);
  const go = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const reserved = useRef(onReserved);
  reserved.current = onReserved;

  const finish = useCallback((bookingId: string, status: string) => {
    attempt.current = null;
    setPending(null);
    setProblem(null);
    go("idle");
    reserved.current(bookingId, status);
  }, []);

  const check = useCallback(async () => {
    const cur = attempt.current;
    if (!cur || busy.current) return;
    busy.current = true;
    go("checking");
    setProblem(MESSAGES.checking);
    const r = await findByToken(cur.a.token);
    busy.current = false;
    if (r.kind === "found") return finish(r.bookingId, r.status);
    if (r.kind === "absent") {
      // An answer from the database: nothing was made. The token is kept for "try again".
      setPending(null);
      setProblem(MESSAGES.absent);
      return go("idle");
    }
    setProblem(MESSAGES.uncertain);
    go("uncertain");
  }, [finish]);

  const submit = useCallback(async (sel: Selection) => {
    if (busy.current || phaseRef.current !== "idle") return;
    if (!onlineManager.isOnline()) {
      setProblem(MESSAGES.offline);
      return;
    }
    if (!attempt.current || attempt.current.sel.key !== sel.key) {
      const start = new Date(sel.start);
      attempt.current = {
        sel,
        a: newAttempt({ mode: sel.mode, clubId: sel.clubId, courtId: sel.courtId, start, end: new Date(start.getTime() + sel.minutes * 60_000) }),
      };
    }
    const cur = attempt.current;
    busy.current = true;
    setPending(cur.sel);
    setProblem(null);
    go("sending");
    const r = await reserve(cur.a);
    busy.current = false;
    if (r.kind === "reserved") return finish(r.value.bookingId, "confirmed");
    if (r.kind === "refused") {
      attempt.current = null; // the database said no; a new tap is a new attempt
      setPending(null);
      setProblem(r.failure.message);
      return go("idle");
    }
    setProblem(MESSAGES.uncertain);
    go("uncertain");
    if (onlineManager.isOnline()) void check();
  }, [check, finish]);

  // When the connection comes back, find out what happened — never assume.
  useEffect(
    () => onlineManager.subscribe((online) => {
      if (online && phaseRef.current === "uncertain") void check();
    }),
    [check],
  );

  return {
    phase,
    locked: phase !== "idle",
    pending,
    problem,
    submit,
    check,
    clearProblem: () => { if (phaseRef.current === "idle") setProblem(null); },
  };
}
