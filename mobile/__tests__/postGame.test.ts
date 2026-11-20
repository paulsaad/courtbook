/**
 * Post a game (J6) and Edit game (J7): the arguments post_match receives on each path, the outcome
 * after every kind of answer — above all that a lost answer is checked, never posted twice — and
 * the edit limits and waiting-request sentence mirrored from update_match.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { getUser: jest.fn() } } }));

import { QueryClient } from "@tanstack/react-query";
import {
  checkPost, initialDraft, missing, NOT_POSTED, POST_ARG_NAMES, postArgs, postDays, postGame, startTimes, UNCERTAIN_POST, type PostDraft,
} from "../lib/postGame";
import { editLimits, editNote } from "../lib/gameEdit";

const qc = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
const club = { timezone: "Asia/Beirut", openTime: "08:00:00", closeTime: "23:00:00", slotMinutes: 30 };
const draftB = (o: Partial<PostDraft> = {}): PostDraft => ({ ...initialDraft(), sport: "padel", clubId: "c1", date: "2026-11-25", time: "18:00", ...o });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const netErr = { message: "TypeError: Network request failed" };

describe("post_match arguments", () => {
  it("without a booking: club, sport, club-time start, end after the chosen length (Beirut is UTC+2 in November)", () => {
    const a = postArgs(draftB({ minutes: 120, note: "  bring balls  " }), club, null);
    expect(Object.keys(a).sort()).toEqual([...POST_ARG_NAMES].sort());
    expect(a).toMatchObject({ p_club: "c1", p_sport: "padel", p_start: "2026-11-25T16:00:00.000Z", p_end: "2026-11-25T18:00:00.000Z", p_booking: null, p_note: "bring balls", p_players_needed: 3 });
  });
  it.each(["open", "approval"] as const)("join mode %s is sent as chosen", (mode) => {
    expect(postArgs(draftB({ joinMode: mode }), club, null).p_join_mode).toBe(mode);
  });
  it("from a booking: only the booking, the court's sport and the game's own choices; the server takes club and time", () => {
    const a = postArgs({ ...initialDraft("b1"), levelMin: 4, levelMax: 6, joinMode: "approval" }, null, { sport: "tennis" });
    expect(a).toEqual({ p_club: null, p_sport: "tennis", p_start: null, p_end: null, p_booking: "b1", p_level_min: 4, p_level_max: 6, p_players_needed: 1, p_note: null, p_join_mode: "approval" });
  });
  it("defaults are the website's: 1 player from a booking, 3 otherwise, join straight away, all levels", () => {
    expect(initialDraft("b1")).toMatchObject({ playersNeeded: 1, joinMode: "open", levelMin: null, levelMax: null });
    expect(initialDraft()).toMatchObject({ playersNeeded: 3, joinMode: "open" });
  });
  it("Post waits for sport, club, day and time without a booking; nothing with one", () => {
    expect(missing(initialDraft())).toBe("Choose a sport.");
    expect(missing({ ...initialDraft(), sport: "padel" })).toBe("Choose a club.");
    expect(missing(draftB({ time: null }))).toBe("Choose a day and a start time.");
    expect(missing(draftB())).toBeNull();
    expect(missing(initialDraft("b1"))).toBeNull();
  });
});

describe("times and days offered", () => {
  it("every 30 minutes, ending by closing time", () => {
    const t = startTimes(club, "2026-11-25", 90, new Date("2026-11-20T00:00:00Z"));
    expect(t[0]).toBe("08:00");
    expect(t[t.length - 1]).toBe("21:30");
  });
  it("today: only times still ahead (club time)", () => {
    const t = startTimes(club, "2026-11-20", 60, new Date("2026-11-20T16:10:00Z")); // 18:10 in Beirut
    expect(t[0]).toBe("18:30");
  });
  it("60 days, today first (post_match refuses 60 days ahead or more)", () => {
    const d = postDays("Asia/Beirut");
    expect(d).toHaveLength(60);
  });
});

describe("posting: one game, whatever happens to the answer", () => {
  const args = postArgs(draftB(), club, null);
  it("done: the new game's id", async () => {
    const rpc = jest.fn(async () => ({ data: "g1", error: null }));
    await expect(postGame(qc(), args, { available: true, rpc })).resolves.toEqual({ kind: "done", gameId: "g1" });
    expect(rpc).toHaveBeenCalledWith("post_match", args);
  });
  it("a second tap while the first call runs sends nothing new", async () => {
    const d = deferred<{ data: unknown; error: unknown }>();
    const rpc = jest.fn(() => d.promise);
    const q = qc();
    const a = postGame(q, args, { available: true, rpc });
    const b = postGame(q, args, { available: true, rpc });
    d.resolve({ data: "g1", error: null });
    expect(await a).toEqual(await b);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("answer lost, game found: opens it, posts nothing more", async () => {
    const rpc = jest.fn(async () => ({ data: null, error: netErr }));
    const lookup = jest.fn(async () => "g1");
    await expect(postGame(qc(), args, { available: true, rpc, lookup })).resolves.toEqual({ kind: "done", gameId: "g1", recovered: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("answer lost, no game: says so; posting again is then safe", async () => {
    const rpc = jest.fn(async () => { throw new TypeError("Network request failed"); });
    const out = await postGame(qc(), args, { available: true, rpc, lookup: async () => null });
    expect(out).toMatchObject({ kind: "refused", failure: { message: NOT_POSTED } });
  });
  it("answer lost and the check fails too: uncertain, and the screen may only check again", async () => {
    const since = new Date("2026-11-20T10:00:00Z");
    const rpc = jest.fn(async () => ({ data: null, error: netErr }));
    const out = await postGame(qc(), args, { available: true, rpc, lookup: async () => { throw new TypeError("Network request failed"); }, now: () => since });
    expect(out).toMatchObject({ kind: "uncertain", failure: { message: UNCERTAIN_POST }, since });
    // the check never calls post_match
    await expect(checkPost(qc(), args, since, async () => "g1")).resolves.toEqual({ kind: "done", gameId: "g1", recovered: true });
    await expect(checkPost(qc(), args, since, async () => null)).resolves.toEqual({ kind: "none" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("the lookup looks only for this post's game: the same club, sport and start, made since it began", async () => {
    const lookup = jest.fn(async () => null);
    const since = new Date("2026-11-20T10:00:00Z");
    await postGame(qc(), args, { available: true, rpc: async () => ({ data: null, error: netErr }), lookup, now: () => since });
    expect(lookup).toHaveBeenCalledWith(args, since);
  });
  it("a booking that already has a game: opens that game", async () => {
    const a = postArgs(initialDraft("b1"), null, { sport: "padel" });
    const rpc = jest.fn(async () => ({ data: null, error: { message: "booking_already_posted", code: "P0001" } }));
    await expect(postGame(qc(), a, { available: true, rpc, lookup: async () => "g9" })).resolves.toMatchObject({ kind: "existing", gameId: "g9" });
  });
  it.each([
    ["too_far_ahead", "Games can be posted up to 60 days ahead."],
    ["too_many_games", "You already have 10 open games. Close one to post another."],
    ["slot_in_past", "That time has passed."],
    ["sport_mismatch", "That booking is for a different sport."],
    ["booking_not_found", "Pick one of your own upcoming bookings."],
    ["bad_players_needed", "Choose between 1 and 30 players."],
  ])("refused (%s): one sentence, nothing looked up or retried", async (code, sentence) => {
    const rpc = jest.fn(async () => ({ data: null, error: { message: code, code: "P0001" } }));
    const lookup = jest.fn(async () => "x");
    await expect(postGame(qc(), args, { available: true, rpc, lookup })).resolves.toEqual({ kind: "refused", failure: expect.objectContaining({ message: sentence }) });
    expect(lookup).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("switched off: nothing reaches the server", async () => {
    const rpc = jest.fn();
    await expect(postGame(qc(), args, { available: false, rpc })).resolves.toMatchObject({ kind: "refused" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("edit limits (update_match)", () => {
  it("not after a cancel or the start; never below the players already in", () => {
    expect(editLimits({ status: "cancelled", started: false, finished: false, joined: 0 })).toMatchObject({ editable: false, reason: "This game was cancelled." });
    expect(editLimits({ status: "open", started: true, finished: false, joined: 0 })).toMatchObject({ editable: false, reason: "This game has already started." });
    expect(editLimits({ status: "open", started: false, finished: false, joined: 3 })).toEqual({ editable: true, reason: null, minPlayers: 3 });
    expect(editLimits({ status: "closed", started: false, finished: false, joined: 0 })).toMatchObject({ editable: true, minPlayers: 1 });
  });
});

describe("Ask to join → Join straight away: what happens to waiting requests (S15)", () => {
  const d = { status: "open" as const, closed_reason: null, joined: 1, pending: 3, join_mode: "approval" as const };
  it("nothing to say unless switching to Join straight away with requests waiting", () => {
    expect(editNote(d, { joinMode: "approval", playersNeeded: 3 })).toBeNull();
    expect(editNote({ ...d, pending: 0 }, { joinMode: "open", playersNeeded: 3 })).toBeNull();
    expect(editNote({ ...d, join_mode: "open" }, { joinMode: "open", playersNeeded: 3 })).toBeNull();
  });
  it("places for everyone: all accepted", () => {
    expect(editNote(d, { joinMode: "open", playersNeeded: 5 })).toBe("The 3 waiting requests will be accepted when you save.");
  });
  it("fewer places: accepted in the order they asked, the rest keep waiting", () => {
    expect(editNote(d, { joinMode: "open", playersNeeded: 3 })).toBe("When you save, 2 waiting players are accepted in the order they asked. The others keep waiting for your answer.");
  });
  it("the game stays full or private: they keep waiting", () => {
    expect(editNote({ ...d, joined: 3 }, { joinMode: "open", playersNeeded: 3 })).toBe("The 3 waiting requests will keep waiting for your answer.");
    expect(editNote({ ...d, status: "closed", closed_reason: "full", joined: 3 }, { joinMode: "open", playersNeeded: 4 })).toBe("When you save, 1 waiting player is accepted in the order they asked. The others keep waiting for your answer.");
  });
});
