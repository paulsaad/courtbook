import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";
import { supabase } from "./supabase";
import type { Failure } from "./errors";
import { gameFailure } from "./gameErrors";
import { createSingleFlight } from "./singleFlight";
import { GAME_WRITES_AVAILABLE } from "./gameActions";

/**
 * Game chat (docs/m3/03-journeys.md J8; 05-architecture.md §5.4) on the existing database:
 *  - who: the organiser and accepted players (is_match_member — row-level security on read and write);
 *  - read: match_messages_list(p_match, p_after); deleted messages come back empty with deleted = true;
 *  - send: an insert into match_messages with an id made on the phone, so a retry after a lost
 *    answer can never make a second message (the second insert hits the primary key);
 *  - the server stamps created_at and limits each sender to 30 messages per game per 10 minutes
 *    (0072 chat guard: slow_down), and refuses messages in a cancelled game (match_cancelled);
 *  - delete own: delete_match_message (soft: the thread stays readable).
 * Polling every 4 s with a 10 s overlap (a message stamped earlier can commit after a newer one was
 * read), de-duplicated by id; a full reload every 60 s, on opening and when the app comes back
 * (deletions of older messages have no newer stamp). No Realtime.
 */

/** On where the chat guard (0072) is applied, like the other game writes: the staging database. */
export const CHAT_AVAILABLE = GAME_WRITES_AVAILABLE;

export const POLL_MS = 4_000;
export const OVERLAP_MS = 10_000;
export const FULL_RELOAD_MS = 60_000;
export const MESSAGE_MAX = 1000;
export const COUNTER_FROM = 900;

export type ServerMessage = { id: string; profile_id: string; name: string | null; body: string; created_at: string; deleted: boolean; /** M3-S: the reader blocked the sender (text withheld) */ blocked?: boolean };
export type ChatMessage = ServerMessage & { local?: "sending" | "failed" };
export type ChatData = { messages: ChatMessage[]; fullAt: number };

export const chatKey = (id: string) => ["chat", id] as const;

const byTime = (a: ChatMessage, b: ChatMessage) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.created_at < b.created_at ? -1 : 1);

/**
 * Merge a server read into what is on screen. A full read is the truth for every server row (a
 * deleted message turns into "Message deleted"); an incremental read only adds or updates rows.
 * Messages still on their way (local) stay until the server returns their id.
 */
export function mergeMessages(current: ChatMessage[], incoming: ServerMessage[], full: boolean): ChatMessage[] {
  const seen = new Map<string, ChatMessage>();
  if (!full) for (const m of current) if (!m.local) seen.set(m.id, m);
  for (const m of incoming) seen.set(m.id, m);
  for (const m of current) if (m.local && !seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort(byTime);
}

/** The newest server stamp, minus the overlap: where the next incremental read starts. */
export function cursorFor(messages: ChatMessage[]): string | null {
  const newest = messages.filter((m) => !m.local).at(-1);
  return newest ? new Date(Date.parse(newest.created_at) - OVERLAP_MS).toISOString() : null;
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const defaultRpc: Rpc = (fn, args) => supabase.rpc(fn, args);

export async function readChat(matchId: string, prev: ChatData | undefined, now = Date.now(), rpc: Rpc = defaultRpc): Promise<ChatData> {
  const full = !prev || now - prev.fullAt >= FULL_RELOAD_MS;
  const after = full ? null : cursorFor(prev!.messages);
  const { data, error } = await rpc("match_messages_list", { p_match: matchId, p_after: after });
  if (error) throw error;
  const rows = (data ?? []) as ServerMessage[];
  return { messages: mergeMessages(prev?.messages ?? [], rows, full), fullAt: full ? now : prev!.fullAt };
}

/** Polls while the screen is open and the app is in front; full reload on open and on return. */
export function useChat(matchId: string, enabled: boolean) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: chatKey(matchId),
    enabled: enabled && !!matchId,
    queryFn: () => readChat(matchId, qc.getQueryData<ChatData>(chatKey(matchId))),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: 1,
  });
  // back to the front: force the next read to be a full one
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      qc.setQueryData<ChatData>(chatKey(matchId), (d) => (d ? { ...d, fullAt: 0 } : d));
      void qc.invalidateQueries({ queryKey: chatKey(matchId) });
    });
    return () => sub.remove();
  }, [qc, matchId]);
  return q;
}

export type SendOutcome = { kind: "sent" } | { kind: "failed"; failure: Failure; retry: boolean } | { kind: "signed-out"; failure: Failure };

/** Messages the chat screen shows for a refused send (UX §4.8, J8). */
export function sendFailure(error: unknown): Failure {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  // row-level security: no longer the organiser or an accepted player
  if (e.code === "42501" || (typeof e.message === "string" && /row-level security/i.test(e.message))) {
    return { kind: "refused", message: "You're no longer in this game.", reason: "not_member" };
  }
  return gameFailure(error);
}

const flight = createSingleFlight();

/**
 * Send one message. The id is the phone's, made once per message: a retry sends the same id, and if
 * the first attempt did reach the server the database refuses the copy (primary key, 23505), which
 * counts as sent. Network failures can be retried (same id); refusals cannot.
 */
export async function sendMessage(
  qc: QueryClient, matchId: string, me: string, msg: { id: string; body: string },
  insert: (row: Record<string, unknown>) => PromiseLike<{ error: unknown }> = (row) => supabase.from("match_messages").insert(row),
): Promise<SendOutcome> {
  return flight.run(`chat:${msg.id}`, async () => {
    let error: unknown = null;
    try { ({ error } = await insert({ id: msg.id, match_id: matchId, profile_id: me, body: msg.body })); } catch (e) { error = e; }
    const dup = (error as { code?: unknown } | null)?.code === "23505";
    if (!error || dup) {
      setLocal(qc, matchId, msg.id, undefined);
      void qc.invalidateQueries({ queryKey: chatKey(matchId) });
      return { kind: "sent" };
    }
    const failure = sendFailure(error);
    if (failure.kind === "auth") return { kind: "signed-out", failure };
    setLocal(qc, matchId, msg.id, "failed");
    return { kind: "failed", failure, retry: failure.kind === "network" };
  });
}

/** Put a message on screen at once ("Sending…"), stamped now; the server's row replaces it. */
export function addLocal(qc: QueryClient, matchId: string, me: string, myName: string | null, msg: { id: string; body: string }) {
  qc.setQueryData<ChatData>(chatKey(matchId), (d) => ({
    fullAt: d?.fullAt ?? 0,
    messages: mergeMessages(d?.messages ?? [], [], false).concat({ id: msg.id, profile_id: me, name: myName, body: msg.body, created_at: new Date().toISOString(), deleted: false, local: "sending" }),
  }));
}

function setLocal(qc: QueryClient, matchId: string, id: string, local: ChatMessage["local"]) {
  qc.setQueryData<ChatData>(chatKey(matchId), (d) => d && { ...d, messages: d.messages.map((m) => (m.id === id ? { ...m, local } : m)) });
}

/** Delete one of my messages; shown as deleted at once, confirmed by the next read. */
export async function deleteMessage(qc: QueryClient, matchId: string, id: string, rpc: Rpc = defaultRpc): Promise<Failure | null> {
  const { error } = await rpc("delete_match_message", { p_id: id });
  if (error) return gameFailure(error);
  qc.setQueryData<ChatData>(chatKey(matchId), (d) => d && { ...d, messages: d.messages.map((m) => (m.id === id ? { ...m, body: "", deleted: true } : m)) });
  return null;
}

/** A message id made on the phone (RFC 4122 v4). */
export function newMessageId(rand: () => number = Math.random): string {
  const h = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  h[12] = "4";
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Day separator text: Today, Yesterday, "Sat 21 Nov" (club time). */
export function dayLabel(iso: string, tz: string, now = new Date()): string {
  const day = formatInTimeZone(new Date(iso), tz, "yyyy-MM-dd");
  if (day === formatInTimeZone(now, tz, "yyyy-MM-dd")) return "Today";
  if (day === formatInTimeZone(new Date(now.getTime() - 864e5), tz, "yyyy-MM-dd")) return "Yesterday";
  return formatInTimeZone(new Date(iso), tz, "EEE d MMM");
}

export type ChatRow = { kind: "day"; key: string; label: string } | { kind: "msg"; key: string; m: ChatMessage; first: boolean; last: boolean };

/** Day separators and runs (same sender, same day): name above the first bubble, time under the last. */
export function chatRows(messages: ChatMessage[], tz: string, now = new Date()): ChatRow[] {
  const out: ChatRow[] = [];
  messages.forEach((m, i) => {
    const day = dayLabel(m.created_at, tz, now);
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const prevDay = prev ? dayLabel(prev.created_at, tz, now) : null;
    const nextDay = next ? dayLabel(next.created_at, tz, now) : null;
    if (day !== prevDay) out.push({ kind: "day", key: `day-${day}-${m.id}`, label: day });
    out.push({
      kind: "msg", key: m.id, m,
      first: !prev || prev.profile_id !== m.profile_id || prevDay !== day,
      last: !next || next.profile_id !== m.profile_id || nextDay !== day,
    });
  });
  return out;
}

/** What a composer may do now: the game's state decides, in the order the spec lists them. */
export type ComposerState = { canSend: boolean; reason: string | null; canDeleteConversation: boolean };
export function composerState(g: { member: boolean; cancelled: boolean; finished: boolean }, online: boolean): ComposerState {
  if (!g.member) return { canSend: false, reason: "You're no longer in this game.", canDeleteConversation: false };
  if (g.cancelled) return { canSend: false, reason: "This game was cancelled.", canDeleteConversation: true };
  if (g.finished) return { canSend: false, reason: "This game has been played. The conversation is read-only.", canDeleteConversation: true };
  if (!online) return { canSend: false, reason: "You're offline", canDeleteConversation: false };
  return { canSend: true, reason: null, canDeleteConversation: false };
}

/** Screen hook: send / retry / delete, re-rendering when a send starts and ends. */
export function useChatActions(matchId: string, me: string | null, myName: string | null) {
  const qc = useQueryClient();
  const [, setTick] = useState(0);
  const bodies = useRef(new Map<string, string>());
  const send = useCallback(async (body: string, id = newMessageId()): Promise<{ id: string; out: SendOutcome }> => {
    if (!me) return { id, out: { kind: "signed-out", failure: { kind: "auth", message: "Sign in again." } } };
    bodies.current.set(id, body);
    addLocal(qc, matchId, me, myName, { id, body });
    setTick((t) => t + 1);
    try { return { id, out: await sendMessage(qc, matchId, me, { id, body }) }; } finally { setTick((t) => t + 1); }
  }, [qc, matchId, me, myName]);
  const retry = useCallback(async (id: string) => {
    const body = bodies.current.get(id);
    if (!body || !me) return null;
    setLocal(qc, matchId, id, "sending");
    setTick((t) => t + 1);
    try { return await sendMessage(qc, matchId, me, { id, body }); } finally { setTick((t) => t + 1); }
  }, [qc, matchId, me]);
  const remove = useCallback((id: string) => deleteMessage(qc, matchId, id), [qc, matchId]);
  /** A refused message is taken off screen (it was never saved). */
  const discard = useCallback((id: string) => {
    qc.setQueryData<ChatData>(chatKey(matchId), (d) => d && { ...d, messages: d.messages.filter((m) => m.id !== id) });
  }, [qc, matchId]);
  return { send, retry, remove, discard };
}
