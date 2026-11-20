import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { Failure } from "./errors";
import { gameFailure } from "./gameErrors";
import { GAME_WRITES_AVAILABLE } from "./gameActions";

/**
 * Report, block, community rules and Help & Feedback (docs/m3/05-architecture.md §5.6; UX §4.6).
 * Every call is one function of migration 0074 (supabase/migrations/0074_safety.sql).
 *
 * ON WHEN THE DATABASE HAS 0074, decided at run time (useSafety): the app asks my_account_status once
 * per session; if the function does not exist yet, no safety control is drawn. So one app update works
 * before and after 0074 is applied (and after a rollback), and only where game writes are on (staging).
 * The community rules are shown whenever the server asks for them (`rules_not_accepted`), whatever
 * this says, so chat can never get stuck on that refusal.
 */
export const safetyKey = ["safety"] as const;
export type SafetyState = { available: boolean; suspended: boolean };
export const SAFETY_OFF: SafetyState = { available: false, suspended: false };

/** PostgREST's answer for a function that is not in the database (before 0074, or after a rollback). */
export function isMissingFunction(error: unknown): boolean {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; status?: unknown };
  return e.code === "PGRST202" || e.code === "42883" || (typeof e.message === "string" && /could not find the function/i.test(e.message));
}

export async function fetchSafety(rpc: Rpc = defaultRpc): Promise<SafetyState> {
  const { data, error } = await rpc("my_account_status", {});
  if (error) {
    if (isMissingFunction(error)) return SAFETY_OFF;
    throw error;                       // offline or a server problem: asked again later, controls stay off
  }
  return { available: true, suspended: data === "suspended" };
}

/** Safety controls and my suspension, for this session. Off until known, and off wherever game writes are. */
export function useSafety(signedIn: boolean): SafetyState {
  const q = useQuery({
    queryKey: safetyKey,
    enabled: signedIn && GAME_WRITES_AVAILABLE,
    staleTime: 5 * 60_000,
    queryFn: () => fetchSafety(),
  });
  return q.data ?? SAFETY_OFF;
}

export type ReportKind = "message" | "player" | "game";
export type ReportReason = "spam" | "abuse" | "inappropriate" | "danger" | "other";

/** UX §4.6, in order. */
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

/**
 * Community rules shown once before the first message. Wording approved by Paul on 20 Nov (sports only;
 * no harassment, unwanted romantic advances or solicitation); one copy for the website and the app.
 */
export { COMMUNITY_RULES } from "@shared/types";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const defaultRpc: Rpc = (fn, args) => supabase.rpc(fn, args);

export async function reportContent(kind: ReportKind, target: string, reason: ReportReason, note: string, rpc: Rpc = defaultRpc): Promise<Failure | null> {
  const n = note.trim();
  const { error } = await rpc("report_content", { p_kind: kind, p_target: target, p_reason: reason, p_note: n === "" ? null : n.slice(0, REPORT_NOTE_MAX) });
  return error ? gameFailure(error) : null;
}

export async function blockPlayer(profileId: string, rpc: Rpc = defaultRpc): Promise<Failure | null> {
  const { error } = await rpc("block_player", { p_profile: profileId });
  return error ? gameFailure(error) : null;
}

export async function unblockPlayer(profileId: string, rpc: Rpc = defaultRpc): Promise<Failure | null> {
  const { error } = await rpc("unblock_player", { p_profile: profileId });
  return error ? gameFailure(error) : null;
}

export const rulesKey = ["rules-accepted"] as const;

/** Whether the player accepted the community rules (asked once, before the first message). */
export function useRulesAccepted(enabled: boolean) {
  return useQuery({
    queryKey: rulesKey,
    enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_rules_accepted");
      if (error) throw error;
      return data === true;
    },
  });
}

export function useAcceptRules() {
  const qc = useQueryClient();
  return async (): Promise<Failure | null> => {
    const { error } = await supabase.rpc("accept_community_rules");
    if (error) return gameFailure(error);
    qc.setQueryData(rulesKey, true);
    return null;
  };
}

export const blockedKey = ["blocked-players"] as const;
export type BlockedPlayer = { profile_id: string; name: string | null; created_at: string };

/** The players I blocked (my_blocked_players). Only ever the blocker's own list. */
export function useBlockedPlayers(enabled: boolean) {
  return useQuery({
    queryKey: blockedKey,
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_blocked_players");
      if (error) throw error;
      return (data ?? []) as BlockedPlayer[];
    },
  });
}

/** After a block or unblock: my list, and every board and game (blocked organisers' games are hidden). */
export function afterBlockChange(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [blockedKey, ["games"], ["club-games"], ["game"]]) void qc.invalidateQueries({ queryKey: k });
}

/**
 * The approved safety model when a block meets a game both players are already in: the game stays as
 * it is (nobody is moved or told); the blocker does not see the other player's messages and gets no
 * chat notices from them; the organiser can remove them, a player can leave. Shown to the blocker only.
 */
export function blockedNotice(
  people: { profile_id: string; name: string | null; is_organizer: boolean }[] | null | undefined,
  blocked: BlockedPlayer[] | undefined, me: string | null, iOrganise: boolean,
): string | null {
  if (!people || !blocked?.length || !me) return null;
  const ids = new Set(blocked.map((b) => b.profile_id));
  const here = people.filter((p) => p.profile_id !== me && ids.has(p.profile_id));
  if (here.length === 0) return null;
  const host = here.find((p) => p.is_organizer);
  const names = here.map((p) => p.name ?? "a player");
  const who = host ? "the organiser of this game" : names.length === 1 ? `${names[0]}, who is in this game` : `${names.length} players in this game`;
  const next = iOrganise ? "You can remove them." : "You can leave the game if you'd rather not play.";
  return `You blocked ${who}. You won't see their messages. ${next}`;
}

// ---- Help & Feedback (Profile) -----------------------------------------------------------------
export type FeedbackKind = "app_problem" | "suggestion";
export const FEEDBACK_MAX = 1000;
export const FEEDBACK_TEXT: Record<FeedbackKind, { title: string; prompt: string }> = {
  app_problem: { title: "Report an app problem", prompt: "What happened? What did you tap, and what did you expect?" },
  suggestion: { title: "Suggest an improvement", prompt: "What would make CourtBook better for you?" },
};
export const FEEDBACK_THANKS = "Thanks. Only the CourtBook team sees this.";
export const CONTACT_EMAIL = "courtbook.contact@gmail.com";

/** What the team needs to look into a problem: platform, version and update. Nothing about the person. */
export function feedbackContext(os: string, build: { label: string; value: string }[]): string {
  const v = build.find((r) => r.label === "Version")?.value;
  const u = build.find((r) => r.label === "Update")?.value;
  return [os, v, u ? `update ${u.slice(0, 8)}` : "built-in code"].filter(Boolean).join(" · ").slice(0, 200);
}

export async function sendFeedback(kind: FeedbackKind, text: string, context: string, rpc: Rpc = defaultRpc): Promise<Failure | null> {
  const body = text.trim();
  if (!body) return { kind: "refused", message: "Write a few words first.", reason: "text_required" };
  const { error } = await rpc("send_feedback", { p_kind: kind, p_text: body.slice(0, FEEDBACK_MAX), p_context: context });
  return error ? gameFailure(error) : null;
}

export type RecentPlayer = { profile_id: string; name: string | null; last_game: string };
/** Players I can report from Profile: from my games (last 60 days and upcoming), as the game screens show them. */
export function useRecentPlayers(enabled: boolean) {
  return useQuery({
    queryKey: ["recent-players"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_recent_players");
      if (error) throw error;
      return (data ?? []) as RecentPlayer[];
    },
  });
}

export const SUSPENDED_TITLE = "Account suspended";
export const SUSPENDED_TEXT = "You can't post, join or message for now. Contact courtbook.contact@gmail.com.";

/** Argument names as on the draft (checked by the unit tests against the SQL file). */
export const SAFETY_RPC_ARGS = {
  report_content: ["p_kind", "p_target", "p_reason", "p_note"],
  block_player: ["p_profile"],
  unblock_player: ["p_profile"],
  my_blocked_players: [],
  my_account_status: [],
  send_feedback: ["p_kind", "p_text", "p_context"],
  my_recent_players: [],
} as const;
