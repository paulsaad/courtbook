import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { Failure } from "./errors";
import { gameFailure } from "./gameErrors";

/**
 * Report, block and community rules (docs/m3/05-architecture.md §5.6; UX §4.6 "Report", "Community
 * rules"). Every call is one function of migration M3-S (supabase/migrations/0074_safety.sql).
 *
 * OFF until M3-S is approved and applied: no control is drawn while this is false, and the chat does
 * not ask for the rules (the database does not require them yet).
 */
export const SAFETY_AVAILABLE = false;

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
 * Community rules shown once before the first message. The wording follows the draft terms of use
 * ("Matches and chat") — FOR PAUL'S REVIEW with the terms (release plan D6) before M3-S goes live.
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
    enabled: enabled && SAFETY_AVAILABLE,
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
    enabled: enabled && SAFETY_AVAILABLE,
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

/** Whether my account is suspended (my_account_status), so the app explains it up front. */
export function useAccountStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["account-status"],
    enabled: enabled && SAFETY_AVAILABLE,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_account_status");
      if (error) throw error;
      return data === "suspended" ? "suspended" as const : "active" as const;
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
} as const;
