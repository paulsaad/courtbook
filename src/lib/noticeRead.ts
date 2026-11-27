/**
 * H11 (Paul, 26 Nov): opening game A marks only game A's notices read; game B's unread notices stay unread.
 * The game page used to call mark_notifications_read(p_ids: null), which marks EVERY notice of the player read —
 * on any visit, and again on each #91 refresh of the page. Now it reads the player's own unread notices for this
 * game and passes exactly those ids; with none, it calls nothing. Never null.
 * mark_notifications_read (0025) itself only touches the caller's own unread rows.
 */
export const NOTICES_READ_EVENT = "courtbook:notices-read";

type Rows = { data: { id: string }[] | null; error: unknown };
type Client = {
  from: (t: "notifications") => { select: (c: "id") => { eq: (c: string, v: string) => { eq: (c: string, v: string) => { is: (c: "read_at", v: null) => PromiseLike<Rows> } } } };
  rpc: (fn: "mark_notifications_read", args: { p_ids: string[] }) => PromiseLike<{ error: unknown }>;
};

/** Marks this game's own unread notices read; returns the ids it marked (empty when none or on any failure). */
export async function markGameNoticesRead(supabase: Client, userId: string, matchId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase.from("notifications").select("id").eq("profile_id", userId).eq("match_id", matchId).is("read_at", null);
    const ids = error ? [] : (data ?? []).map((r) => r.id);
    if (ids.length === 0) return [];
    const { error: markError } = await supabase.rpc("mark_notifications_read", { p_ids: ids });
    return markError ? [] : ids;
  } catch {
    return [];   // best effort, as before: a failed mark never breaks the game page
  }
}
