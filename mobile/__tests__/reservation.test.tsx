let mockToken = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `tok-${++mockToken}` }));
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
jest.mock("../lib/secureStorage", () => ({ ChunkedSecureStore: {} }));
import { act, renderHook } from "@testing-library/react-native";
import { onlineManager } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { MESSAGES, useReservation, type Selection } from "../lib/reservation";
import { PendingReservations, QUIET_MS, __useStoreForTests, realDeps, reservations } from "../lib/pendingReservation";

/** The club screen's hook, over the real store, the real reserve() and lookup, and a fake database. */
const rpc = supabase.rpc as jest.Mock;
const from = supabase.from as jest.Mock;
const lost = () => Promise.resolve({ data: null, error: { message: "TypeError: Network request failed", code: "" } });
const lookup = (result: unknown) => {
  const c: { select: () => unknown; eq: jest.Mock; maybeSingle: () => Promise<unknown> } = { select: () => c, eq: jest.fn(() => c), maybeSingle: () => Promise.resolve(result) };
  from.mockReturnValueOnce(c);
  return c;
};
const sel = (key = "court|16:30|90", clubId = "club"): Selection => ({
  key, mode: "at_desk", clubId, clubName: "Batroun Padel", timezone: "Asia/Beirut", courtId: "court", courtName: "Padel 1",
  date: "2026-11-15", start: "2026-11-15T14:30:00.000Z", minutes: 90, price: 45,
});
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

let clock = 1_000_000;
const disk = new Map<string, string>();
beforeEach(async () => {
  rpc.mockReset();
  from.mockReset();
  mockToken = 0;
  clock = 1_000_000;
  disk.clear();
  onlineManager.setOnline(true);
  const store = new PendingReservations({
    ...realDeps,
    storage: { getItem: async (k) => disk.get(k) ?? null, setItem: async (k, v) => { disk.set(k, v); }, removeItem: async (k) => { disk.delete(k); } },
    now: () => clock,
  });
  __useStoreForTests(store);
  await store.setUser("u1");
});

async function setup(clubId = "club") {
  const onReserved = jest.fn();
  const view = await renderHook(() => useReservation({ clubId, onReserved }));
  return { onReserved, view };
}

it("locks while the request is out: a second tap sends nothing", async () => {
  let release!: (v: unknown) => void;
  rpc.mockReturnValueOnce(new Promise((r) => { release = r; }));
  const { view, onReserved } = await setup();
  await act(async () => { void view.result.current.submit(sel()); });
  await flush();
  expect(view.result.current.locked).toBe(true);
  expect(view.result.current.pending?.key).toBe(sel().key);
  await act(async () => { void view.result.current.submit(sel("other|17:00|60")); });
  expect(rpc).toHaveBeenCalledTimes(1);
  await act(async () => { release({ data: [{ booking_id: "b1", already: false }], error: null }); });
  await flush();
  expect(onReserved).toHaveBeenCalledWith("b1", "confirmed");
  expect(view.result.current.locked).toBe(false);
});

it("offline: sends nothing and says so", async () => {
  onlineManager.setOnline(false);
  const { view } = await setup();
  await act(async () => { await view.result.current.submit(sel()); });
  expect(rpc).not.toHaveBeenCalled();
  expect(view.result.current.problem).toBe(MESSAGES.offline);
  expect(view.result.current.locked).toBe(false);
});

it("no answer, then back online: finds the booking by its token instead of assuming", async () => {
  rpc.mockImplementation(() => { onlineManager.setOnline(false); return lost(); });
  const { view, onReserved } = await setup();
  await act(async () => { await view.result.current.submit(sel()); });
  await flush();
  expect(view.result.current.phase).toBe("uncertain");
  expect(view.result.current.locked).toBe(true); // still showing exactly what was sent
  expect(view.result.current.problem).toBe(MESSAGES.uncertain);
  expect(onReserved).not.toHaveBeenCalled();
  const c = lookup({ data: { id: "b7", status: "confirmed" }, error: null });
  await act(async () => { onlineManager.setOnline(true); reservationsRecheck(); });
  await flush();
  expect(c.eq).toHaveBeenCalledWith("client_token", "tok-1");
  expect(onReserved).toHaveBeenCalledWith("b7", "confirmed");
}, 15_000);

it("no answer, and later the database has no such booking: unlocks, and trying again reuses the token", async () => {
  rpc.mockImplementationOnce(lost).mockImplementationOnce(lost).mockImplementationOnce(lost);
  lookup({ data: null, error: null }); // too soon to believe
  const { view, onReserved } = await setup();
  await act(async () => { await view.result.current.submit(sel()); });
  await flush();
  expect(view.result.current.phase).toBe("uncertain");
  expect(view.result.current.problem).toBe(MESSAGES.settling);
  clock += QUIET_MS;
  lookup({ data: null, error: null });
  await act(async () => { await view.result.current.check(); });
  expect(view.result.current.phase).toBe("idle");
  expect(view.result.current.problem).toBe(MESSAGES.absent);
  rpc.mockResolvedValueOnce({ data: [{ booking_id: "b8", already: false }], error: null });
  await act(async () => { await view.result.current.submit(sel()); });
  await flush();
  expect(new Set(rpc.mock.calls.map((c) => c[1].p_token))).toEqual(new Set(["tok-1"]));
  expect(onReserved).toHaveBeenCalledWith("b8", "confirmed");
}, 15_000);

it("a refusal is final, unlocks, and a different selection gets a new token", async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: "slot_taken", code: "P0001" } });
  const { view } = await setup();
  await act(async () => { await view.result.current.submit(sel()); });
  expect(view.result.current.phase).toBe("idle");
  expect(view.result.current.problem).toBe("That slot was just taken.");
  rpc.mockResolvedValueOnce({ data: [{ booking_id: "b2" }], error: null });
  await act(async () => { await view.result.current.submit(sel("court|17:00|90")); });
  expect(rpc.mock.calls.map((c) => c[1].p_token)).toEqual(["tok-1", "tok-2"]);
});

it("another club's screen while one is unresolved: blocked, says why, sends nothing", async () => {
  rpc.mockImplementation(() => { onlineManager.setOnline(false); return lost(); });
  const first = await setup("club");
  await act(async () => { await first.view.result.current.submit(sel()); });
  await flush();
  await act(async () => { await first.view.unmount(); });
  rpc.mockReset();
  onlineManager.setOnline(true);
  from.mockImplementation(() => { throw new Error("lookup must not decide here"); });
  const other = await setup("club-2");
  expect(other.view.result.current.blockedBy?.clubId).toBe("club");
  expect(other.view.result.current.locked).toBe(false);
  expect(other.view.result.current.problem).toBe(MESSAGES.blocked);
  await act(async () => { await other.view.result.current.submit(sel("court2|18:00|60", "club-2")); });
  expect(rpc).not.toHaveBeenCalled();
}, 15_000);

// what the root watcher does when the connection returns
function reservationsRecheck() { reservations().recheckIfWaiting(); }

afterAll(() => reservations().dispose());
