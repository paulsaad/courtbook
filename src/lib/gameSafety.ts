/**
 * Website report and block for game chat (M3-S; UX §4.6), the same rules and words as the app
 * (mobile/lib/safety.ts, mobile/components/game/SafetySheets.tsx). Every call is one function of
 * migration 0074: report_content, block_player, unblock_player, my_blocked_players. Nothing here
 * reads another player's details; the only names shown are the ones the chat already shows.
 */

export type ReportReason = "spam" | "abuse" | "inappropriate" | "danger" | "other";

/** UX §4.6, in order (as the app). */
export const REPORT_REASONS: { key: ReportReason; label: string }[] = [
  { key: "spam", label: "Spam" },
  { key: "abuse", label: "Abuse or harassment" },
  { key: "inappropriate", label: "Inappropriate" },
  { key: "danger", label: "Threat or danger" },
  { key: "other", label: "Something else" },
];
export const REPORT_NOTE_MAX = 500;
export const REPORT_THANKS = "Thanks for reporting this. We review every report and act when our community rules are broken.";
export const REPORT_BLOCK_OFFER = "You can also block this player now.";
export const REPORT_DANGER = "If anyone is in danger, contact the police or emergency services now.";

export const BLOCKED_PATH = "/profile/blocked";
/** The app's sentence; its "You can unblock them in Profile" is shown with a link to the website's page (SafetyConfirm). */
export const BLOCK_EXPLAINED = "You won't see their messages or games, and they can't join yours. They aren't told.";
export const UNBLOCK_EXPLAINED = "You'll see their messages and games again, and they can ask to join yours. They aren't told.";

/**
 * Server reasons → one sentence. The website's shared table (friendlyError) is not used here: its
 * `not_found` is about payments and its `bad_target` about admin roles. Unknown errors never show
 * the database's own text.
 */
const SAFETY_ERRORS: Record<string, string> = {
  not_authenticated: "Your session has ended. Sign in again.",
  bad_target: "You can't report or block yourself.",
  bad_reason: "Choose a reason for the report.",
  note_too_long: `Keep the note under ${REPORT_NOTE_MAX} characters.`,
  not_found: "This message or player isn't available any more.",
  account_suspended: "Your account is suspended. Contact courtbook.contact@gmail.com.",
};
const REASONS = Object.keys(SAFETY_ERRORS).sort((a, b) => b.length - a.length);

export const SAFETY_OFFLINE = "Couldn't reach CourtBook. Check your connection and try again.";
export const SAFETY_UNAVAILABLE = "Reporting and blocking aren't available yet. Try again later.";
export const SAFETY_UNKNOWN = "Something went wrong. Try again.";

type ErrorLike = { message?: unknown; code?: unknown; status?: unknown; name?: unknown } | null | undefined;

export function safetyError(error: unknown): string {
  const e = (error ?? {}) as NonNullable<ErrorLike>;
  const message = typeof e.message === "string" ? e.message : String(error ?? "");
  if (/failed to fetch|network request failed|networkerror|load failed/i.test(message)) return SAFETY_OFFLINE;
  // the function is not on this database yet (PostgREST PGRST202)
  if (e.code === "PGRST202") return SAFETY_UNAVAILABLE;
  if (e.code === "PGRST301" || e.status === 401 || /jwt expired/i.test(message)) return SAFETY_ERRORS.not_authenticated;
  const reason = REASONS.find((r) => new RegExp(`(^|[^a-z_])${r}([^a-z_]|$)`).test(message));
  return reason ? SAFETY_ERRORS[reason] : SAFETY_UNKNOWN;
}

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

/** Report one chat message. Only the message id goes to the server; it finds the sender itself. */
export async function reportMessage(rpc: Rpc, messageId: string, reason: ReportReason, note: string): Promise<string | null> {
  const n = note.trim().slice(0, REPORT_NOTE_MAX);
  try {
    const { error } = await rpc("report_content", { p_kind: "message", p_target: messageId, p_reason: reason, p_note: n === "" ? null : n });
    return error ? safetyError(error) : null;
  } catch (e) { return safetyError(e); }
}

export async function blockPlayer(rpc: Rpc, profileId: string): Promise<string | null> {
  try {
    const { error } = await rpc("block_player", { p_profile: profileId });
    return error ? safetyError(error) : null;
  } catch (e) { return safetyError(e); }
}

export async function unblockPlayer(rpc: Rpc, profileId: string): Promise<string | null> {
  try {
    const { error } = await rpc("unblock_player", { p_profile: profileId });
    return error ? safetyError(error) : null;
  } catch (e) { return safetyError(e); }
}

export type BlockedPlayer = { profile_id: string; name: string | null };

/** The players I blocked: only the id and the name, whatever else the server sends. */
export function blockedRows(data: unknown): BlockedPlayer[] {
  return ((data ?? []) as { profile_id: string; name: string | null }[]).map((r) => ({ profile_id: r.profile_id, name: r.name ?? null }));
}
