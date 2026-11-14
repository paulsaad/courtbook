import { onlineManager } from "@tanstack/react-query";
import { ChunkedSecureStore } from "./secureStorage";
import { CALL_TIMEOUT_MS, RESERVE_ATTEMPTS, RESERVE_WAITS_MS, findByToken, newAttempt, reserve, type Attempt, type Lookup, type ReserveResult } from "./reserve";

/**
 * The player's one unresolved reservation, kept until the database says what became of it.
 *
 * A reservation whose answer never arrived may or may not exist. Its retry token is the only way to
 * find out (bookings.client_token, readable by its owner), so the attempt is written to the phone's
 * secure storage *before* the request is sent and survives leaving the screen, the app being closed
 * or killed, and signing out. It is stored per account: another account signed in on the same phone
 * neither sees it nor looks it up (the lookup reads the signed-in player's own bookings, so it would
 * wrongly find nothing). It is removed only when the outcome is established:
 *   - the database returned the booking, or the lookup by token found it          → booked;
 *   - the database refused it by name (slot_taken, …)                             → not booked;
 *   - the lookup found no booking, and enough time has passed since the last
 *     request ended that it can no longer be committed (QUIET_MS)                 → not booked.
 * A timeout, a dropped connection or an unreadable answer never establishes anything.
 *
 * While it is unresolved the player can reserve nothing else, and "Check now" only reads — it never
 * sends the reservation again. No new database logic: book_at_desk / hold_slot with the token, and
 * the player's own bookings read by token.
 */

/** What the player asked for, frozen at the moment they tapped Reserve. */
export type Selection = {
  key: string; // court|start|minutes — a different key is a different reservation
  mode: string;
  clubId: string;
  clubName: string;
  timezone: string;
  courtId: string;
  courtName: string;
  date: string;
  start: string;
  minutes: number;
  price: number | null;
};

/**
 * idle      — nothing unresolved.
 * sending   — the request (and its automatic retries) are in flight.
 * uncertain — no answer: the booking may or may not exist. Checked when online, on return to the
 *             app, every RECHECK_MS, and on "Check now".
 * checking  — reading the database for the attempt's token.
 */
export type Phase = "idle" | "sending" | "uncertain" | "checking";

export const MESSAGES = {
  offline: "You're offline, so nothing was sent. Reserve again when you're back online.",
  uncertain: "We couldn't confirm your booking yet. We'll check as soon as you're back online.",
  checking: "Checking whether your booking went through…",
  settling: "No booking found yet. Making sure — we'll check again in a few seconds.",
  absent: "Your booking didn't go through — nothing was reserved. You can try again.",
  blocked: "Your earlier booking isn't confirmed yet. Nothing else can be reserved until we know.",
} as const;

/**
 * How long after the last request ended the database could still commit it. A request the phone
 * gave up on can still be running at the server: the phone stops waiting after CALL_TIMEOUT_MS, and
 * a signed-in player's statement is cut off by the server after 8 s (Supabase's default
 * statement_timeout for `authenticated`). 30 s leaves a wide margin; "no booking" read before then
 * is not believed.
 */
export const QUIET_MS = 30_000;
/** While unresolved and still unanswered, look again this often (while the app is open). */
export const RECHECK_MS = 30_000;
/** Worst case for one reserve() call, all retries included — used when the app died mid-send. */
export const SEND_WINDOW_MS = RESERVE_ATTEMPTS * CALL_TIMEOUT_MS + RESERVE_WAITS_MS;

const STORAGE_PREFIX = "courtbook.pending-reservation.v1.";
export const storageKey = (userId: string) => `${STORAGE_PREFIX}${userId}`;

/** What is written to the phone. Dates as ISO strings. */
export type Stored = {
  v: 1;
  userId: string;
  sel: Selection;
  token: string;
  mode: string;
  courtId: string;
  clubId: string;
  start: string;
  end: string;
  /** "No booking" is believed only from this moment on. */
  quietAfter: number;
};

export type Outcome =
  | { kind: "booked"; userId: string; sel: Selection; bookingId: string; status: string }
  | { kind: "not-booked"; userId: string; sel: Selection; message: string };

export type State = {
  userId: string | null; // who is signed in now
  loaded: boolean; // that account's stored attempt has been read
  pending: Stored | null; // the signed-in player's unresolved attempt
  phase: Phase; // of `pending`; idle when there is none
  note: string | null; // what to tell the player about `pending`
  outcome: Outcome | null; // how the last attempt ended, until it has been shown
  notice: { clubId: string; message: string } | null; // e.g. "you're offline, nothing was sent"
};

export type SubmitResult = "sent" | "blocked" | "offline" | "signed-out";

export type Deps = {
  storage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> };
  reserve: (a: Attempt) => Promise<ReserveResult>;
  lookup: (token: string) => Promise<Lookup>;
  newAttempt: (a: Omit<Attempt, "token">) => Attempt;
  isOnline: () => boolean;
  now: () => number;
};

const toAttempt = (p: Stored): Attempt => ({ token: p.token, mode: p.mode, clubId: p.clubId, courtId: p.courtId, start: new Date(p.start), end: new Date(p.end) });

function parse(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Stored;
    const ok = p && p.v === 1 && typeof p.userId === "string" && typeof p.token === "string" && p.token.length > 0 &&
      typeof p.courtId === "string" && typeof p.start === "string" && typeof p.end === "string" && typeof p.quietAfter === "number" &&
      p.sel && typeof p.sel.key === "string";
    return ok ? p : null;
  } catch {
    return null;
  }
}

export class PendingReservations {
  private state: State = { userId: null, loaded: false, pending: null, phase: "idle", note: null, outcome: null, notice: null };
  private listeners = new Set<() => void>();
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> = Promise.resolve();
  /** After a reliable "not booked", the token is kept (in memory) for "try again" with the same selection. */
  private retry: { key: string; attempt: Attempt } | null = null;

  constructor(private deps: Deps) {}

  getState = (): State => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((l) => l()); }

  /** The signed-in player's unresolved attempt, or null. */
  mine(): Stored | null {
    const { pending, userId } = this.state;
    return pending && userId && pending.userId === userId ? pending : null;
  }

  /**
   * Who is signed in. Switching account sets the previous account's attempt aside (it stays stored)
   * and reads this account's, left by an earlier run of the app.
   */
  setUser(userId: string | null): Promise<void> {
    if (userId === this.state.userId) return this.loading;
    this.clearTimer();
    this.busy = false;
    this.retry = null;
    this.set({ userId, loaded: false, pending: null, phase: "idle", note: null, outcome: null, notice: null });
    if (!userId) return (this.loading = Promise.resolve());
    this.loading = (async () => {
      let p: Stored | null = null;
      try {
        const raw = await this.deps.storage.getItem(storageKey(userId));
        p = parse(raw);
        if (p && p.userId !== userId) p = null;
        if (raw && !p) await this.deps.storage.removeItem(storageKey(userId)).catch(() => {}); // unreadable: no token to look up
      } catch {
        p = null;
      }
      if (this.state.userId !== userId) return; // signed out or switched while reading
      this.set({ loaded: true, ...(p ? { pending: p, phase: "uncertain" as Phase, note: MESSAGES.uncertain } : {}) });
      this.recheckIfWaiting();
    })();
    return this.loading;
  }

  /** Called on reconnect, on return to the app and by the timer. Only when nothing is in flight. */
  recheckIfWaiting() {
    if (this.mine() && this.state.phase === "uncertain" && this.deps.isOnline()) void this.check();
  }

  async submit(sel: Selection): Promise<SubmitResult> {
    await this.loading; // never start before this account's stored attempt has been read
    const userId = this.state.userId;
    if (!userId) return "signed-out";
    if (this.busy || this.mine()) return "blocked"; // one unresolved reservation at a time
    if (!this.deps.isOnline()) {
      this.set({ notice: { clubId: sel.clubId, message: MESSAGES.offline } });
      return "offline";
    }
    const start = new Date(sel.start);
    const attempt = this.retry && this.retry.key === sel.key
      ? this.retry.attempt
      : this.deps.newAttempt({ mode: sel.mode, clubId: sel.clubId, courtId: sel.courtId, start, end: new Date(start.getTime() + sel.minutes * 60_000) });
    const pending: Stored = {
      v: 1, userId, sel, token: attempt.token, mode: attempt.mode, clubId: attempt.clubId, courtId: attempt.courtId,
      start: attempt.start.toISOString(), end: attempt.end.toISOString(),
      quietAfter: this.deps.now() + SEND_WINDOW_MS + QUIET_MS, // if the app dies mid-send
    };
    this.busy = true;
    this.set({ pending, phase: "sending", note: null, outcome: null, notice: null });
    // Written before anything is sent: whatever happens next, the token can be looked up.
    await this.save(pending);
    const r = await this.deps.reserve(attempt);
    this.busy = false;
    if (this.state.userId !== userId) return "sent"; // signed out meanwhile: stays stored for that account
    if (r.kind === "reserved") {
      await this.settle({ kind: "booked", userId, sel, bookingId: r.value.bookingId, status: r.value.confirmed ? "confirmed" : "pending" });
      return "sent";
    }
    if (r.kind === "refused") {
      this.retry = null; // the database said no; a new tap is a new attempt
      await this.settle({ kind: "not-booked", userId, sel, message: r.failure.message });
      return "sent";
    }
    const waiting = { ...pending, quietAfter: this.deps.now() + QUIET_MS };
    this.set({ pending: waiting, phase: "uncertain", note: MESSAGES.uncertain });
    await this.save(waiting);
    this.recheckIfWaiting();
    return "sent";
  }

  /** Read the database for the attempt's token. Never sends the reservation again. */
  async check(): Promise<void> {
    const p = this.mine();
    if (!p || this.busy) return;
    this.busy = true;
    this.clearTimer();
    this.set({ phase: "checking", note: MESSAGES.checking });
    const r = await this.deps.lookup(p.token);
    this.busy = false;
    if (this.mine()?.token !== p.token) return; // signed out or switched meanwhile
    if (r.kind === "found") {
      return this.settle({ kind: "booked", userId: p.userId, sel: p.sel, bookingId: r.bookingId, status: r.status });
    }
    const now = this.deps.now();
    if (r.kind === "absent" && now >= p.quietAfter) {
      this.retry = { key: p.sel.key, attempt: toAttempt(p) };
      return this.settle({ kind: "not-booked", userId: p.userId, sel: p.sel, message: MESSAGES.absent });
    }
    // Not found too soon to believe, or no answer at all: still unknown.
    const early = r.kind === "absent";
    this.set({ phase: "uncertain", note: early ? MESSAGES.settling : MESSAGES.uncertain });
    this.schedule(early ? Math.max(1_000, p.quietAfter - now) : RECHECK_MS);
  }

  /** The outcome has been shown (or the player moved on). */
  acknowledge() { if (this.state.outcome) this.set({ outcome: null }); }
  /** Clear a message about this club's last attempt, once the player changes their selection. */
  dismiss(clubId: string) {
    const { outcome, notice } = this.state;
    const patch: Partial<State> = {};
    if (outcome?.kind === "not-booked" && outcome.sel.clubId === clubId) patch.outcome = null;
    if (notice?.clubId === clubId) patch.notice = null;
    if (Object.keys(patch).length) this.set(patch);
  }

  private async settle(outcome: Outcome) {
    this.clearTimer();
    this.set({ pending: null, phase: "idle", note: null, outcome });
    await this.deps.storage.removeItem(storageKey(outcome.userId)).catch(() => {});
  }

  private async save(p: Stored) {
    try { await this.deps.storage.setItem(storageKey(p.userId), JSON.stringify(p)); } catch { /* kept in memory for this run */ }
  }

  private schedule(ms: number) {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; this.recheckIfWaiting(); }, ms);
  }
  /** Stop any scheduled look-up (tests, and a store being replaced). */
  dispose() { this.clearTimer(); this.listeners.clear(); }
  private clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}

export const realDeps: Deps = {
  storage: ChunkedSecureStore,
  reserve: (a) => reserve(a),
  lookup: findByToken,
  newAttempt,
  isOnline: () => onlineManager.isOnline(),
  now: () => Date.now(),
};

let store = new PendingReservations(realDeps);
/** The app's one store. */
export const reservations = () => store;
/** Tests only: start from a fresh store with the given dependencies. */
export function __useStoreForTests(s: PendingReservations) { store.dispose(); store = s; }
