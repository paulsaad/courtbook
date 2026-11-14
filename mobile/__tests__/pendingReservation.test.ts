jest.mock("../lib/supabase", () => ({ supabase: {} }));
jest.mock("../lib/secureStorage", () => ({ ChunkedSecureStore: {} }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "unused" }));
import type { Attempt, Lookup, ReserveResult } from "../lib/reserve";
import { CALL_TIMEOUT_MS } from "../lib/reserve";
import { MESSAGES, PendingReservations, QUIET_MS, RECHECK_MS, SEND_WINDOW_MS, SERVER_STATEMENT_TIMEOUT_MS, storageKey, type Deps, type Selection } from "../lib/pendingReservation";

/**
 * The unresolved-reservation store on its own, with a fake phone storage, a fake database and a
 * clock under the test's control. Each requirement from the 2026-11-14 review has a test here.
 */
type Db = { bookings: Map<string, { id: string; status: string }> };

function world() {
  const disk = new Map<string, string>();
  const db: Db = { bookings: new Map() };
  let clock = 1_000_000;
  let online = true;
  let n = 0;
  const reserveCalls: Attempt[] = [];
  let authLost = 0;
  let failWrites = false;
  const lookups: string[] = [];
  let nextReserve: (a: Attempt) => Promise<ReserveResult> = async () => ({ kind: "uncertain", failure: { kind: "network", message: "x" } as never });
  let nextLookup: (t: string) => Promise<Lookup> = async (t) => {
    const b = db.bookings.get(t);
    return b ? { kind: "found", bookingId: b.id, status: b.status } : { kind: "absent" };
  };
  const deps: Deps = {
    storage: {
      getItem: async (k) => disk.get(k) ?? null,
      setItem: async (k, v) => { if (failWrites) throw new Error("keychain unavailable"); disk.set(k, v); },
      removeItem: async (k) => { disk.delete(k); },
    },
    reserve: (a) => { reserveCalls.push(a); return nextReserve(a); },
    lookup: (t) => { lookups.push(t); return nextLookup(t); },
    newAttempt: (a) => ({ ...a, token: `tok-${++n}` }),
    isOnline: () => online,
    now: () => clock,
    onAuthLost: () => { authLost++; },
  };
  return {
    disk, db, deps, reserveCalls, lookups,
    authLost: () => authLost,
    failWrites: (v: boolean) => { failWrites = v; },
    store: () => new PendingReservations(deps),
    tick: (ms: number) => { clock += ms; },
    setOnline: (v: boolean) => { online = v; },
    onReserve: (f: typeof nextReserve) => { nextReserve = f; },
    onLookup: (f: typeof nextLookup) => { nextLookup = f; },
  };
}

const sel = (key = "court|16:30|90", clubId = "club"): Selection => ({
  key, mode: "at_desk", clubId, clubName: "Batroun Padel", timezone: "Asia/Beirut", courtId: "court", courtName: "Padel 1",
  date: "2026-11-15", start: "2026-11-15T14:30:00.000Z", minutes: 90, price: 45,
});
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const unreachable = async (): Promise<Lookup> => ({ kind: "unreachable" });
const noAnswer = async (): Promise<ReserveResult> => ({ kind: "uncertain", failure: { kind: "network", message: "x" } as never });

afterEach(() => jest.useRealTimers());

describe("1 — the attempt and its token survive leaving the screen and restarting the app", () => {
  test("written to the phone before the request is sent", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    let onDiskWhenSent: string | undefined;
    w.onReserve(async () => { onDiskWhenSent = w.disk.get(storageKey("u1")); return noAnswer(); });
    w.setOnline(true);
    w.onLookup(unreachable);
    await s.submit(sel());
    expect(onDiskWhenSent && JSON.parse(onDiskWhenSent).token).toBe("tok-1");
    s.dispose();
  });

  test("app killed mid-send: the next run finds the booking by the same token", async () => {
    const w = world();
    const first = w.store();
    await first.setUser("u1");
    w.onReserve(() => new Promise(() => {})); // never answers: the app dies here
    void first.submit(sel());
    await settle();
    first.dispose();
    w.db.bookings.set("tok-1", { id: "b1", status: "confirmed" }); // the request had reached the database
    const next = w.store();
    await next.setUser("u1");
    await settle();
    expect(w.lookups).toEqual(["tok-1"]);
    expect(next.getState().outcome).toMatchObject({ kind: "booked", bookingId: "b1" });
    expect(w.disk.has(storageKey("u1"))).toBe(false);
    expect(w.reserveCalls).toHaveLength(1); // checking never re-sends
    next.dispose();
  });

  test("restored while offline: shown as unresolved; nothing looked up or sent until back online", async () => {
    const w = world();
    const first = w.store();
    await first.setUser("u1");
    w.onReserve(noAnswer);
    w.onLookup(unreachable);
    await first.submit(sel());
    first.dispose();
    const lookupsBefore = w.lookups.length;
    w.setOnline(false);
    const next = w.store();
    await next.setUser("u1");
    await settle();
    expect(next.mine()?.token).toBe("tok-1");
    expect(next.getState().phase).toBe("uncertain");
    expect(w.lookups.length).toBe(lookupsBefore);
    w.setOnline(true);
    w.db.bookings.set("tok-1", { id: "b5", status: "confirmed" });
    w.onLookup(async () => ({ kind: "found", bookingId: "b5", status: "confirmed" }));
    next.recheckIfWaiting(); // what the root watcher does on reconnect
    await settle();
    expect(next.getState().outcome).toMatchObject({ kind: "booked", bookingId: "b5" });
    expect(w.reserveCalls).toHaveLength(1);
    next.dispose();
  });

  test("another account on the same phone neither sees nor checks it; the owner gets it back", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(noAnswer);
    w.onLookup(unreachable);
    await s.submit(sel());
    const lookupsBefore = w.lookups.length;
    w.onLookup(async () => { throw new Error("must not look up under another account"); });
    await s.setUser("u2");
    expect(s.mine()).toBeNull();
    s.recheckIfWaiting();
    await settle();
    expect(w.lookups.length).toBe(lookupsBefore);
    // u2 may reserve; u1's attempt stays stored
    w.onReserve(async () => ({ kind: "reserved", value: { bookingId: "b-u2", paymentId: null, holdExpiresAt: null, already: false, confirmed: true } }));
    expect(await s.submit(sel("other|18:00|60"))).toBe("sent");
    expect(w.disk.has(storageKey("u1"))).toBe(true);
    w.db.bookings.set("tok-1", { id: "b-u1", status: "confirmed" });
    w.onLookup(async (t) => (w.db.bookings.has(t) ? { kind: "found", bookingId: w.db.bookings.get(t)!.id, status: "confirmed" } : { kind: "absent" }));
    w.tick(QUIET_MS);
    await s.setUser("u1");
    await settle();
    expect(s.getState().outcome).toMatchObject({ kind: "booked", bookingId: "b-u1" });
    s.dispose();
  });
});

describe("3 — nothing else can be reserved while it is unresolved", () => {
  test("any other selection, at this club or another, is refused without sending", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(noAnswer);
    w.onLookup(unreachable);
    await s.submit(sel());
    expect(await s.submit(sel("court|18:00|90"))).toBe("blocked");
    expect(await s.submit(sel("k9|18:00|60", "club-2"))).toBe("blocked");
    expect(w.reserveCalls).toHaveLength(1);
    s.dispose();
  });

  test("blocked while the first request is still in flight, too", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(() => new Promise(() => {}));
    void s.submit(sel());
    await settle();
    expect(await s.submit(sel("k9|18:00|60", "club-2"))).toBe("blocked");
    expect(w.reserveCalls).toHaveLength(1);
    s.dispose();
  });
});

describe("4 — checking again is safe", () => {
  test("Check now only reads; repeated taps never send the reservation again", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(noAnswer);
    w.onLookup(unreachable);
    await s.submit(sel());
    await Promise.all([s.check(), s.check(), s.check()]);
    expect(w.reserveCalls).toHaveLength(1);
    expect(new Set(w.lookups)).toEqual(new Set(["tok-1"]));
    s.dispose();
  });

  test("Check now during the send does nothing", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(() => new Promise(() => {}));
    void s.submit(sel());
    await settle();
    await s.check();
    expect(w.lookups).toHaveLength(0);
    s.dispose();
  });

  test("after a reliable 'not booked', trying the same selection again reuses the token", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(noAnswer);
    w.onLookup(async () => ({ kind: "absent" }));
    await s.submit(sel());
    w.tick(QUIET_MS);
    await s.check();
    expect(s.getState().outcome).toMatchObject({ kind: "not-booked" });
    w.onReserve(async () => ({ kind: "reserved", value: { bookingId: "b2", paymentId: null, holdExpiresAt: null, already: true, confirmed: true } }));
    await s.submit(sel());
    expect(w.reserveCalls.map((a) => a.token)).toEqual(["tok-1", "tok-1"]);
    s.dispose();
  });
});

describe("5 — a timeout or a dropped connection never means 'nothing was reserved'", () => {
  test("no answer from the lookup: still unresolved, still stored, looked at again later", async () => {
    jest.useFakeTimers();
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(noAnswer);
    w.onLookup(unreachable);
    await s.submit(sel());
    w.tick(10 * 60_000);
    await s.check();
    expect(s.getState().phase).toBe("uncertain");
    expect(s.getState().note).toBe(MESSAGES.uncertain);
    expect(w.disk.has(storageKey("u1"))).toBe(true);
    w.db.bookings.set("tok-1", { id: "b3", status: "confirmed" });
    w.onLookup(async () => ({ kind: "found", bookingId: "b3", status: "confirmed" }));
    await jest.advanceTimersByTimeAsync(RECHECK_MS);
    expect(s.getState().outcome).toMatchObject({ kind: "booked", bookingId: "b3" });
    s.dispose();
  });

  test("'no booking' read too soon after the request is not believed; it is read again once it can be", async () => {
    jest.useFakeTimers();
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(noAnswer);
    let calls = 0;
    // the abandoned request commits a few seconds after the phone gave up
    w.onLookup(async () => (++calls === 1 ? { kind: "absent" } : { kind: "found", bookingId: "late", status: "confirmed" }));
    await s.submit(sel()); // looked up at once: absent
    expect(s.getState().phase).toBe("uncertain");
    expect(s.getState().note).toBe(MESSAGES.settling);
    expect(s.getState().outcome).toBeNull();
    w.tick(QUIET_MS);
    await jest.advanceTimersByTimeAsync(QUIET_MS);
    expect(s.getState().outcome).toMatchObject({ kind: "booked", bookingId: "late" });
    s.dispose();
  });

  test("killed mid-send: 'no booking' is not believed until the whole send window has passed", async () => {
    const w = world();
    const first = w.store();
    await first.setUser("u1");
    w.onReserve(() => new Promise(() => {}));
    void first.submit(sel());
    await settle();
    first.dispose();
    w.onLookup(async () => ({ kind: "absent" }));
    w.tick(SEND_WINDOW_MS); // not yet the quiet time on top of it
    const next = w.store();
    await next.setUser("u1");
    await settle();
    expect(next.mine()?.token).toBe("tok-1");
    w.tick(QUIET_MS);
    await next.check();
    expect(next.getState().outcome).toMatchObject({ kind: "not-booked", message: MESSAGES.absent });
    next.dispose();
  });
});

describe("6 — cleared only when the outcome is established", () => {
  test("booked: cleared", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(async () => ({ kind: "reserved", value: { bookingId: "b1", paymentId: null, holdExpiresAt: null, already: false, confirmed: true } }));
    await s.submit(sel());
    expect(s.mine()).toBeNull();
    expect(w.disk.size).toBe(0);
    expect(s.getState().outcome).toMatchObject({ kind: "booked", bookingId: "b1", status: "confirmed" });
  });

  test("refused by the database by name: cleared, with the database's reason", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(async () => ({ kind: "refused", failure: { kind: "refused", message: "That slot was just taken." } as never }));
    await s.submit(sel());
    expect(s.mine()).toBeNull();
    expect(w.disk.size).toBe(0);
    expect(s.getState().outcome).toMatchObject({ kind: "not-booked", message: "That slot was just taken." });
  });

  test("'not booked' after the quiet time: cleared, and then a new reservation is allowed", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(noAnswer);
    w.onLookup(async () => ({ kind: "absent" }));
    await s.submit(sel());
    expect(w.disk.size).toBe(1);
    w.tick(QUIET_MS);
    await s.check();
    expect(w.disk.size).toBe(0);
    w.onReserve(async () => ({ kind: "reserved", value: { bookingId: "b9", paymentId: null, holdExpiresAt: null, already: false, confirmed: true } }));
    expect(await s.submit(sel("k9|18:00|60", "club-2"))).toBe("sent");
  });

  test("an unreadable stored attempt is discarded rather than crashing the app", async () => {
    const w = world();
    w.disk.set(storageKey("u1"), "{not json");
    const s = w.store();
    await s.setUser("u1");
    expect(s.mine()).toBeNull();
    expect(w.disk.has(storageKey("u1"))).toBe(false);
  });
});

describe("review corrections (2026-11-14)", () => {
  test("the token cannot be saved: nothing is sent, the player is told, and nothing is left blocking", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.failWrites(true);
    w.onReserve(async () => { throw new Error("must not send"); });
    expect(await s.submit(sel())).toBe("not-saved");
    expect(w.reserveCalls).toHaveLength(0);
    expect(s.mine()).toBeNull();
    expect(s.getState().phase).toBe("idle");
    expect(s.getState().notice).toEqual({ clubId: "club", message: MESSAGES.notSaved });
    // storage works again → the same tap goes through normally
    w.failWrites(false);
    w.onReserve(async () => ({ kind: "reserved", value: { bookingId: "b1", paymentId: null, holdExpiresAt: null, already: false, confirmed: true } }));
    expect(await s.submit(sel())).toBe("sent");
    expect(w.reserveCalls).toHaveLength(1);
  });

  test("session rejected after an earlier call got no answer: kept, sign-in asked for, looked up after signing in", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(async () => ({ kind: "uncertain", failure: { kind: "auth", message: "Your session has ended. Sign in again to continue." } as never }));
    w.onLookup(unreachable);
    await s.submit(sel());
    await settle();
    expect(w.lookups).toHaveLength(0); // no lookup with a dead session: it could only fail
    expect(s.mine()?.token).toBe("tok-1");
    expect(s.getState().note).toBe(MESSAGES.signIn);
    expect(w.authLost()).toBe(1);
    expect(w.disk.has(storageKey("u1"))).toBe(true);
    // the app signs out locally, the player signs in again
    await s.setUser(null);
    expect(w.disk.has(storageKey("u1"))).toBe(true);
    w.db.bookings.set("tok-1", { id: "b-first-call", status: "confirmed" });
    w.onLookup(async (t) => (w.db.bookings.has(t) ? { kind: "found", bookingId: w.db.bookings.get(t)!.id, status: "confirmed" } : { kind: "absent" }));
    await s.setUser("u1");
    await settle();
    expect(s.getState().outcome).toMatchObject({ kind: "booked", bookingId: "b-first-call" });
    expect(w.reserveCalls).toHaveLength(1);
  });

  test("session rejected during the lookup: still unresolved, sign-in asked for, nothing cleared", async () => {
    const w = world();
    const s = w.store();
    await s.setUser("u1");
    w.onReserve(noAnswer);
    w.onLookup(async () => ({ kind: "unreachable", auth: true }));
    await s.submit(sel());
    w.tick(10 * 60_000);
    await s.check();
    expect(s.mine()?.token).toBe("tok-1");
    expect(s.getState().note).toBe(MESSAGES.signIn);
    expect(w.authLost()).toBeGreaterThan(0);
    expect(w.disk.has(storageKey("u1"))).toBe(true);
    s.dispose();
  });

  test("the quiet time covers the phone's wait plus the server's statement limit, with margin", () => {
    // A request abandoned at the phone's timeout can have reached the server just before; the server
    // then has at most its statement limit to commit. "No booking" is believed only after that.
    expect(SERVER_STATEMENT_TIMEOUT_MS).toBe(8_000); // live: authenticated statement_timeout=8s
    expect(QUIET_MS).toBeGreaterThanOrEqual(SERVER_STATEMENT_TIMEOUT_MS * 3);
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(SERVER_STATEMENT_TIMEOUT_MS);
  });
});
