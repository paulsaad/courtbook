/**
 * Game chat (J8, §5.4): reads never lose a message (overlap + de-duplication, full reloads), a send
 * can never be doubled (phone-made id; the copy hits the primary key), refusals are explained, and
 * the screen only lets members write — and only while the game takes messages.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
const mockParams = { current: { id: "m1" } as Record<string, string> };
const mockBack = jest.fn();
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn(), back: () => mockBack(), navigate: jest.fn() }, Stack: { Screen: () => null }, useLocalSearchParams: () => mockParams.current }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
jest.mock("../lib/online", () => ({ useOnline: () => true }));
jest.mock("../lib/gameActions", () => ({ ...jest.requireActual("../lib/gameActions"), GAME_WRITES_AVAILABLE: true }));

import type { ReactNode } from "react";
import { Alert } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import {
  chatRows, composerState, cursorFor, dayLabel, FULL_RELOAD_MS, mergeMessages, newMessageId, OVERLAP_MS, readChat, sendFailure, sendMessage,
  type ChatMessage, type ServerMessage,
} from "../lib/chat";
import { gameKeys } from "../lib/games";
import Chat from "../app/chat/[id]";
import type { GameDetail } from "../lib/gameTypes";

const msg = (id: string, at: string, o: Partial<ServerMessage> = {}): ServerMessage => ({ id, profile_id: "nour", name: "Nour", body: `text ${id}`, created_at: at, deleted: false, ...o });
const qc = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });

describe("reading: nothing lost, nothing doubled", () => {
  it("an incremental read adds and de-duplicates; order is (time, id)", () => {
    const cur = [msg("a", "2026-11-20T10:00:00Z"), msg("b", "2026-11-20T10:00:05Z")];
    const out = mergeMessages(cur, [msg("b", "2026-11-20T10:00:05Z"), msg("c", "2026-11-20T10:00:03Z")], false);
    expect(out.map((m) => m.id)).toEqual(["a", "c", "b"]);
  });
  it("a full read is the truth: a deleted message becomes deleted; a message still sending stays", () => {
    const local: ChatMessage = { ...msg("x", "2026-11-20T10:01:00Z", { profile_id: "me" }), local: "sending" };
    const out = mergeMessages([msg("a", "2026-11-20T10:00:00Z"), local], [msg("a", "2026-11-20T10:00:00Z", { body: "", deleted: true })], true);
    expect(out).toEqual([expect.objectContaining({ id: "a", deleted: true }), expect.objectContaining({ id: "x", local: "sending" })]);
  });
  it("the next read starts 10 s before the newest message the server returned", () => {
    expect(cursorFor([msg("a", "2026-11-20T10:00:30Z")])).toBe(new Date(Date.parse("2026-11-20T10:00:30Z") - OVERLAP_MS).toISOString());
    expect(cursorFor([])).toBeNull();
  });
  it("full read when opening and every 60 s; incremental in between", async () => {
    const rpc = jest.fn(async () => ({ data: [msg("a", "2026-11-20T10:00:30Z")], error: null }));
    const first = await readChat("m1", undefined, 1_000_000, rpc);
    expect(rpc).toHaveBeenLastCalledWith("match_messages_list", { p_match: "m1", p_after: null });
    await readChat("m1", first, 1_000_000 + 4_000, rpc);
    expect(rpc).toHaveBeenLastCalledWith("match_messages_list", { p_match: "m1", p_after: "2026-11-20T10:00:20.000Z" });
    await readChat("m1", first, 1_000_000 + FULL_RELOAD_MS, rpc);
    expect(rpc).toHaveBeenLastCalledWith("match_messages_list", { p_match: "m1", p_after: null });
  });
});

describe("sending: one message, whatever happens to the answer", () => {
  it("message ids are UUID v4, different each time", () => {
    const a = newMessageId(), b = newMessageId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
  it("the phone's id is sent; a retry whose first attempt did arrive hits the primary key and counts as sent", async () => {
    const insert = jest.fn(async () => ({ error: { code: "23505", message: "duplicate key value violates unique constraint \"match_messages_pkey\"" } }));
    await expect(sendMessage(qc(), "m1", "me", { id: "id-1", body: "hi" }, insert)).resolves.toEqual({ kind: "sent" });
    expect(insert).toHaveBeenCalledWith({ id: "id-1", match_id: "m1", profile_id: "me", body: "hi" });
  });
  it("no connection: failed, may be retried with the same id", async () => {
    const out = await sendMessage(qc(), "m1", "me", { id: "id-2", body: "hi" }, async () => { throw new TypeError("Network request failed"); });
    expect(out).toMatchObject({ kind: "failed", retry: true });
  });
  it.each([
    [{ code: "P0001", message: "slow_down" }, "You're sending messages quickly. Wait a moment."],
    [{ code: "P0001", message: "match_cancelled" }, "This game was cancelled."],
    [{ code: "42501", message: "new row violates row-level security policy for table \"match_messages\"" }, "You're no longer in this game."],
  ])("refused %o: explained, not retried", async (error, sentence) => {
    const out = await sendMessage(qc(), "m1", "me", { id: `r-${sentence.length}`, body: "hi" }, async () => ({ error }));
    expect(out).toMatchObject({ kind: "failed", retry: false, failure: { message: sentence } });
    expect(sendFailure(error).message).toBe(sentence);
  });
});

describe("who may write, and when", () => {
  it.each([
    [{ member: false, cancelled: false, finished: false }, true, false, "You're no longer in this game."],
    [{ member: true, cancelled: true, finished: false }, true, false, "This game was cancelled."],
    [{ member: true, cancelled: false, finished: true }, true, false, "This game has been played. The conversation is read-only."],
    [{ member: true, cancelled: false, finished: false }, false, false, "You're offline"],
    [{ member: true, cancelled: false, finished: false }, true, true, null],
  ])("%o online=%s", (g, online, canSend, reason) => {
    expect(composerState(g, online)).toMatchObject({ canSend, reason });
  });
  it("day separators and runs", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    const rows = chatRows([
      msg("a", "2026-11-20T08:00:00Z"), msg("b", "2026-11-21T08:00:00Z"), msg("c", "2026-11-21T08:01:00Z"), msg("d", "2026-11-21T08:02:00Z", { profile_id: "me" }),
    ], "Asia/Beirut", now);
    expect(rows.map((r) => (r.kind === "day" ? r.label : `${r.key}${r.first ? "^" : ""}${r.last ? "$" : ""}`))).toEqual(["Yesterday", "a^$", "Today", "b^", "c$", "d^$"]);
    expect(dayLabel("2026-11-18T08:00:00Z", "Asia/Beirut", now)).toBe("Wed 18 Nov");
  });
});

// ---- the screen ----
const game: GameDetail = {
  match_id: "m1", club_id: "c1", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", club_timezone: "Asia/Beirut", town: "Batroun",
  sport: "padel", start_at: "2030-01-05T16:00:00Z", end_at: "2030-01-05T17:30:00Z", level_min: null, level_max: null, level_legacy: false, my_level: null,
  players_needed: 3, joined: 1, pending: 0, status: "open", closed_reason: null, court_lost: false, note: null, join_mode: "open",
  organizer_id: "me", organizer_name: "Emma", my_status: null, i_organize: true, has_court: false, booking_id: null, court_name: null,
  started: false, finished: false, hidden: false,
};
const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
/** `has0074`: the database has the safety functions (my_account_status answers); otherwise PostgREST's "not found". */
async function show(d: GameDetail, messages: ServerMessage[], has0074 = false) {
  const q = qc();
  q.setQueryData(gameKeys.detail("m1"), d, { updatedAt: Date.now() + 864e5 });
  q.setQueryData(["activity"], [], { updatedAt: Date.now() + 864e5 });
  (supabase.rpc as jest.Mock).mockImplementation(async (fn: string) => {
    if (fn === "match_messages_list") return { data: messages, error: null };
    if (fn === "match_detail") return { data: [d], error: null };
    if (fn === "my_account_status") return has0074 ? { data: "active", error: null } : { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    if (fn === "my_rules_accepted") return { data: true, error: null };
    return { data: null, error: null };
  });
  await render(<SafeAreaProvider initialMetrics={metrics}><QueryClientProvider client={q}><Chat /></QueryClientProvider></SafeAreaProvider>);
  return q;
}

describe("chat screen", () => {
  beforeEach(() => jest.clearAllMocks());

  it("members see the messages, with names on others' runs and a composer", async () => {
    await show(game, [msg("a", "2026-11-20T10:00:00Z", { body: "Running 5 minutes late" }), msg("b", "2026-11-20T10:01:00Z", { profile_id: "me", name: "Emma", body: "No problem" })]);
    expect(await screen.findByText("Running 5 minutes late")).toBeTruthy();
    expect(screen.getByText("Nour")).toBeTruthy();
    expect(screen.queryByText("Emma")).toBeNull(); // own messages carry no name
    expect(screen.getByLabelText("Message the group")).toBeTruthy();
  });

  it("an empty chat says so", async () => {
    await show(game, []);
    expect(await screen.findByText("No messages yet")).toBeTruthy();
  });

  it("sending: the message appears at once and goes to the server with its own id", async () => {
    const insert = jest.fn(async () => ({ error: null }));
    (supabase.from as jest.Mock).mockReturnValue({ insert });
    await show(game, []);
    await fireEvent.changeText(await screen.findByLabelText("Message the group"), "See you at 6");
    await fireEvent.press(screen.getByTestId("chat-send"));
    expect(await screen.findByText("See you at 6")).toBeTruthy();
    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ match_id: "m1", profile_id: "me", body: "See you at 6", id: expect.stringMatching(/^[0-9a-f-]{36}$/) }));
  });

  it("a refused message is taken back into the composer with the reason", async () => {
    (supabase.from as jest.Mock).mockReturnValue({ insert: jest.fn(async () => ({ error: { code: "P0001", message: "slow_down" } })) });
    await show(game, []);
    await fireEvent.changeText(await screen.findByLabelText("Message the group"), "one more");
    await fireEvent.press(screen.getByTestId("chat-send"));
    expect(await screen.findByText("You're sending messages quickly. Wait a moment.")).toBeTruthy();
    expect(screen.getByLabelText("Message the group").props.value).toBe("one more");
  });

  it("not in the game: no chat, no composer", async () => {
    await show({ ...game, i_organize: false, my_status: "pending" }, []);
    expect(await screen.findByText("You're no longer in this game.")).toBeTruthy();
    expect(screen.queryByLabelText("Message the group")).toBeNull();
  });

  it("cancelled: read-only, and the player may delete the conversation for themselves", async () => {
    await show({ ...game, status: "cancelled" }, [msg("a", "2026-11-20T10:00:00Z")]);
    expect(await screen.findByText("This game was cancelled.")).toBeTruthy();
    expect(screen.queryByLabelText("Message the group")).toBeNull();
    expect(screen.getByText("Delete conversation")).toBeTruthy();
  });

  it("long press: only my own messages can be deleted", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await show(game, [msg("a", "2026-11-20T10:00:00Z"), msg("b", "2026-11-20T10:01:00Z", { profile_id: "me" })]);
    await fireEvent(await screen.findByTestId("msg-a"), "longPress");
    expect(alert).not.toHaveBeenCalled();
    await fireEvent(screen.getByTestId("msg-b"), "longPress");
    expect(alert).toHaveBeenCalledWith("Delete this message?", expect.any(String), expect.any(Array));
    alert.mockRestore();
  });

  it("with 0074: long press on another player's message offers Report and Block", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    await show(game, [msg("a", "2026-11-20T10:00:00Z")], true);
    await waitFor(async () => {
      await fireEvent(screen.getByTestId("msg-a"), "longPress");
      expect(alert).toHaveBeenCalledWith("Nour", undefined, expect.arrayContaining([expect.objectContaining({ text: "Report message" }), expect.objectContaining({ text: "Block Nour" })]));
    });
    alert.mockRestore();
  });

  it("before the app knows 0074 is there, a rules refusal still shows the rules (chat never sticks)", async () => {
    (supabase.from as jest.Mock).mockReturnValue({ insert: jest.fn(async () => ({ error: { code: "P0001", message: "rules_not_accepted" } })) });
    await show(game, []);
    await fireEvent.changeText(await screen.findByLabelText("Message the group"), "Hello");
    await fireEvent.press(screen.getByTestId("chat-send"));
    expect(await screen.findByText(/for organising sports/)).toBeTruthy();
    expect(screen.getByLabelText("Message the group").props.value).toBe("Hello");
  });

  it("a deleted message reads “Message deleted”", async () => {
    await show(game, [msg("a", "2026-11-20T10:00:00Z", { body: "", deleted: true })]);
    expect(await screen.findByText("Message deleted")).toBeTruthy();
  });
});


