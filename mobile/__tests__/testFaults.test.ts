jest.mock("expo-updates", () => ({ channel: "production" }));
jest.mock("../lib/supabase", () => ({ supabase: {} }));
jest.mock("../lib/secureStorage", () => ({ ChunkedSecureStore: {} }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "unused" }));
import type { Attempt, Lookup, ReserveResult } from "../lib/reserve";
import { __setFaultsAvailableForTests, currentFault, faultsAvailable, setFault, withLookupFault, withReserveFault } from "../lib/testFaults";
import { PendingReservations, storageKey, type Deps, type Selection } from "../lib/pendingReservation";

const a: Attempt = { token: "tok-1", mode: "at_desk", clubId: "club", courtId: "court", start: new Date("2026-11-15T14:30:00Z"), end: new Date("2026-11-15T16:00:00Z") };
const booked: ReserveResult = { kind: "reserved", value: { bookingId: "b1", paymentId: null, holdExpiresAt: null, already: false, confirmed: true } };

afterEach(() => { __setFaultsAvailableForTests(true); setFault("off"); });

describe("test faults", () => {
  test("on the production channel: not offered, cannot be turned on, everything passes straight through", async () => {
    __setFaultsAvailableForTests(false);
    expect(faultsAvailable()).toBe(false); // jest's __DEV__ is true, so the real check is forced off here
    expect(setFault("answer-lost")).toBe(false);
    expect(currentFault()).toBe("off");
    const real = jest.fn(async () => booked);
    expect(await withReserveFault(real, a)).toBe(booked);
    const look = jest.fn(async (): Promise<Lookup> => ({ kind: "absent" }));
    expect(await withLookupFault(look, "t")).toEqual({ kind: "absent" });
  });

  test("answer lost: the reservation is really sent exactly once, its answer dropped; lookups not sent", async () => {
    __setFaultsAvailableForTests(true);
    setFault("answer-lost");
    const real = jest.fn(async () => booked);
    const r = await withReserveFault(real, a);
    expect(real).toHaveBeenCalledTimes(1);
    expect(r.kind).toBe("uncertain");
    const look = jest.fn();
    expect(await withLookupFault(look, "tok-1")).toEqual({ kind: "unreachable" });
    expect(look).not.toHaveBeenCalled();
  });

  test("request lost: nothing is sent", async () => {
    __setFaultsAvailableForTests(true);
    setFault("request-lost");
    const real = jest.fn(async () => booked);
    expect((await withReserveFault(real, a)).kind).toBe("uncertain");
    expect(real).not.toHaveBeenCalled();
  });

  test("off: passes straight through", async () => {
    __setFaultsAvailableForTests(true);
    const real = jest.fn(async () => booked);
    expect(await withReserveFault(real, a)).toBe(booked);
  });

  test("end to end with the store: answer lost → unresolved and stored; fault off → found by its token, one booking", async () => {
    __setFaultsAvailableForTests(true);
    const disk = new Map<string, string>();
    const db = new Map<string, string>(); // token → booking id
    const sent: string[] = [];
    const deps: Deps = {
      storage: { getItem: async (k) => disk.get(k) ?? null, setItem: async (k, v) => { disk.set(k, v); }, removeItem: async (k) => { disk.delete(k); } },
      reserve: (x) => withReserveFault(async (y) => { sent.push(y.token); db.set(y.token, db.get(y.token) ?? `b-${db.size + 1}`); return { kind: "reserved", value: { bookingId: db.get(y.token)!, paymentId: null, holdExpiresAt: null, already: false, confirmed: true } }; }, x),
      lookup: (t) => withLookupFault(async (u) => (db.has(u) ? { kind: "found", bookingId: db.get(u)!, status: "confirmed" } : { kind: "absent" }), t),
      newAttempt: (x) => ({ ...x, token: "tok-1" }),
      isOnline: () => true,
      now: () => 0,
      onAuthLost: () => {},
    };
    const s = new PendingReservations(deps);
    await s.setUser("u1");
    setFault("answer-lost");
    const sel: Selection = { key: "k", mode: "at_desk", clubId: "club", clubName: "Club", timezone: "Asia/Beirut", courtId: "court", courtName: "Padel 1", date: "2026-11-15", start: "2026-11-15T14:30:00.000Z", minutes: 90, price: 45 };
    await s.submit(sel);
    await s.check();
    await s.check();
    expect(s.mine()?.token).toBe("tok-1");
    expect(disk.has(storageKey("u1"))).toBe(true);
    setFault("off");
    await s.check();
    expect(s.getState().outcome).toMatchObject({ kind: "booked", bookingId: "b-1" });
    expect(sent).toEqual(["tok-1"]);
    expect(db.size).toBe(1);
    s.dispose();
  });
});
