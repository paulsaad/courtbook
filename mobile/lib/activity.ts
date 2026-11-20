import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";
import { supabase } from "./supabase";
import type { IconName } from "../components/Icon";

/**
 * Activity (docs/m3/04-ux-spec.md §4.7, 05-architecture.md §5.7): the player's own notices, newest
 * 50, read under their session (RLS: own rows only) — the same list the website shows. Notices are
 * marked read with mark_notifications_read (own unread rows only; the 0069 grant allows nothing but
 * read_at). Deleting notices is not in the app yet.
 */
export type Notice = { id: string; kind: string; match_id: string | null; body: string; created_at: string; read_at: string | null };

export const activityKey = ["activity"] as const;
export const ACTIVITY_LIMIT = 50;

export async function fetchActivity(): Promise<Notice[]> {
  const { data, error } = await supabase.from("notifications")
    .select("id, kind, match_id, body, created_at, read_at")
    .order("created_at", { ascending: false }).limit(ACTIVITY_LIMIT);
  if (error) throw error;
  return (data ?? []) as Notice[];
}

/** Signed-out visitors make no call. Refreshed on focus and every 60 s while on screen (§5.2). */
export function useActivity({ signedIn }: { signedIn: boolean }) {
  return useQuery({ queryKey: activityKey, enabled: signedIn, staleTime: 30_000, refetchInterval: 60_000, queryFn: fetchActivity });
}

/** "99+" above 99, nothing at 0. */
export function badgeText(n: number): string | null {
  return n <= 0 ? null : n > 99 ? "99+" : String(n);
}

export function unreadCount(rows: Notice[] | undefined): number {
  return (rows ?? []).filter((r) => !r.read_at).length;
}

/** Kind → icon (§4.7). Unknown kinds get the plain bell. */
export function kindIcon(kind: string): IconName {
  switch (kind) {
    case "join_request": case "player_joined": return "players";
    case "join_accepted": return "check";
    case "join_declined": case "player_removed": case "match_cancelled": return "close";
    case "player_left": return "back";
    case "match_message": return "chat";
    case "booking_moved": case "match_full_waiting": return "clock";
    case "booking_unlinked": case "court_resolved": return "court";
    default: return "bell";
  }
}

/** "Just now", "5 min ago", "3 h ago", "Yesterday", else "Sat 21 Nov" (Beirut). */
export function relativeTime(iso: string, now: Date = new Date(), tz = "Asia/Beirut"): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60_000) return "Just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  const day = (d: Date) => formatInTimeZone(d, tz, "yyyy-MM-dd");
  if (day(new Date(iso)) === day(now)) return `${Math.floor(ms / 3_600_000)} h ago`;
  if (day(new Date(iso)) === day(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return formatInTimeZone(new Date(iso), tz, "EEE d MMM");
}

/**
 * Marks these notices read on the server, then in the cached list so the badges clear at once.
 * Best effort: a failure changes nothing on screen and the next visit tries again.
 */
export async function markRead(qc: QueryClient, ids: string[], rpc = (fn: string, args: object) => supabase.rpc(fn, args)) {
  if (ids.length === 0) return;
  const { error } = await rpc("mark_notifications_read", { p_ids: ids });
  if (error) return;
  const now = new Date().toISOString();
  qc.setQueryData<Notice[]>(activityKey, (rows) => rows?.map((r) => (ids.includes(r.id) && !r.read_at ? { ...r, read_at: now } : r)));
}

/** Unread ids among `rows` (optionally only one game's), each marked once per screen visit. */
export function useMarkRead(rows: Notice[] | undefined, matchId?: string) {
  const qc = useQueryClient();
  const sent = useRef(new Set<string>());
  const ids = (rows ?? []).filter((r) => !r.read_at && (matchId == null || r.match_id === matchId) && !sent.current.has(r.id)).map((r) => r.id);
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return;
    const list = key.split(",");
    list.forEach((id) => sent.current.add(id));
    void markRead(qc, list);
  }, [key, qc]);
}
