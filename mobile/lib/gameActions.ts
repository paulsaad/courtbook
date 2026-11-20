import { useCallback, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { Failure } from "./errors";
import { gameFailure } from "./gameErrors";
import { createSingleFlight } from "./singleFlight";
import { gameKeys, invalidateAfterGameChange } from "./games";
import type { JoinMode, MatchStatus } from "./gameTypes";
import { PROJECT_REF, refFromUrl } from "./variant";

/**
 * Game actions (stage 3, "Taking part"; docs/m3/05-architecture.md §5.3, 07-roadmap.md stage 3).
 *
 * Each call is one existing database function under the caller's own session. The phone decides
 * nothing: membership, capacity, level fit and court state are the server's (§5.3).
 * `remove` and `resolveCourt` call functions added by 0072 (M3-H hardening).
 *
 * Switched on only where 0072 is applied: the staging database (approved and applied 20 Nov 2026).
 * A bundle pointed at any other database — the live one included — keeps every call refused and
 * draws no action control. Turning it on for live is a separate decision after 0072 reaches live.
 */
export function gameWritesFor(supabaseUrl: string | undefined): boolean {
  return refFromUrl(supabaseUrl ?? "") === PROJECT_REF.staging;
}
export const GAME_WRITES_AVAILABLE = gameWritesFor(process.env.EXPO_PUBLIC_SUPABASE_URL);

/** join_match answers with the caller's status: `accepted` (open game) or `pending` (approval game). */
export type JoinResult = "accepted" | "pending";

/** Edit (update_match). Every field is sent; the server checks each one (bad_players_needed …). */
export type GameEdit = {
  playersNeeded: number; levelMin: number | null; levelMax: number | null; note: string | null; joinMode: JoinMode;
};

export type GameAction =
  | { kind: "join" }
  | { kind: "leave" } // withdraw a request or leave the game: both are leave_match
  | { kind: "decide"; profileId: string; accept: boolean }
  | { kind: "status"; status: MatchStatus } // private (closed), open again, cancel
  | { kind: "edit"; edit: GameEdit }
  | { kind: "hide"; hidden: boolean }
  | { kind: "remove"; profileId: string } // organiser removes an accepted player (GR-6)
  | { kind: "resolveCourt"; bookingId: string | null }; // court booking cancelled: link another, or go ahead without (GR-9)

/**
 * The argument names of each function, as on the database (checked against the replica by
 * supabase/tests/m3/row_types.sh; rpcFor is checked against this list by the unit tests).
 * One function per line: the shell check reads this block.
 */
export const GAME_RPC_ARGS = {
  join_match: ["p_match"],
  leave_match: ["p_match"],
  decide_join: ["p_match", "p_profile", "p_accept"],
  set_match_status: ["p_match", "p_status"],
  update_match: ["p_match", "p_players_needed", "p_level_min", "p_level_max", "p_note", "p_join_mode"],
  hide_match: ["p_match", "p_hidden"],
  remove_player: ["p_match", "p_profile"], // M3-H
  resolve_court: ["p_match", "p_booking"], // M3-H
} as const;

/** Shown if an action is called before writes are switched on (no screen offers one before then). */
export const JOIN_LATER_TEXT = "Joining from the app arrives in the next update.";
export const MANAGE_LATER_TEXT = "Managing games from the app arrives in the next update.";

/** One busy key per action and target, so accepting Adam does not block declining Bana. */
export function actionKey(gameId: string, a: GameAction): string {
  switch (a.kind) {
    case "decide": return `${gameId}:decide:${a.profileId}`;
    case "remove": return `${gameId}:remove:${a.profileId}`;
    default: return `${gameId}:${a.kind}`;
  }
}

/** The RPC and its arguments for an action. Pure, so every mapping is unit-tested against the signatures. */
export function rpcFor(gameId: string, a: GameAction): { fn: string; args: Record<string, unknown> } {
  switch (a.kind) {
    case "join": return { fn: "join_match", args: { p_match: gameId } };
    case "leave": return { fn: "leave_match", args: { p_match: gameId } };
    case "decide": return { fn: "decide_join", args: { p_match: gameId, p_profile: a.profileId, p_accept: a.accept } };
    case "status": return { fn: "set_match_status", args: { p_match: gameId, p_status: a.status } };
    case "edit": return {
      fn: "update_match",
      args: {
        p_match: gameId, p_players_needed: a.edit.playersNeeded, p_level_min: a.edit.levelMin,
        p_level_max: a.edit.levelMax, p_note: a.edit.note, p_join_mode: a.edit.joinMode,
      },
    };
    case "hide": return { fn: "hide_match", args: { p_match: gameId, p_hidden: a.hidden } };
    case "remove": return { fn: "remove_player", args: { p_match: gameId, p_profile: a.profileId } };
    case "resolveCourt": return { fn: "resolve_court", args: { p_match: gameId, p_booking: a.bookingId } };
  }
}

/**
 * What the screen does next.
 *  done      — the server accepted it. `joined` is set for a join.
 *  refused   — the server said no (one sentence to show). The game is re-read: the refusal usually
 *              means the game changed under the player (filled up, closed, court cancelled).
 *  uncertain — the request may or may not have reached the server (no connection mid-call). Never
 *              retried automatically: the game is re-read and the screen shows the real state (§5.3).
 *  signed-out — the session ended; the screen sends the player to sign in.
 */
export type ActionOutcome =
  | { kind: "done"; joined?: JoinResult }
  | { kind: "refused"; failure: Failure }
  | { kind: "uncertain"; failure: Failure }
  | { kind: "signed-out"; failure: Failure };

export function outcomeOf(error: unknown, ctx: { courtLost?: boolean } = {}): ActionOutcome {
  const failure = gameFailure(error, ctx);
  if (failure.kind === "auth") return { kind: "signed-out", failure };
  if (failure.kind === "network") return { kind: "uncertain", failure };
  // unknown errors are treated like refusals: shown once, game re-read, nothing retried
  return { kind: "refused", failure };
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const defaultRpc: Rpc = (fn, args) => supabase.rpc(fn, args);

/** Shared by every screen, so two buttons for the same action on two screens still send one call. */
const flight = createSingleFlight();

/**
 * Run one action. Never throws: every result is an ActionOutcome.
 * After anything but `signed-out`, everything that can show the game is refreshed (M2 prefix
 * invalidation); after `uncertain` that refresh is how the real state is found.
 */
export async function runGameAction(
  qc: QueryClient, gameId: string, a: GameAction,
  opts: { available?: boolean; rpc?: Rpc; courtLost?: boolean } = {},
): Promise<ActionOutcome> {
  const { available = GAME_WRITES_AVAILABLE, rpc = defaultRpc, courtLost } = opts;
  if (!available) {
    const organiser = a.kind === "decide" || a.kind === "status" || a.kind === "edit" || a.kind === "remove" || a.kind === "resolveCourt";
    return { kind: "refused", failure: { kind: "refused", message: organiser ? MANAGE_LATER_TEXT : JOIN_LATER_TEXT, reason: "writes_unavailable" } };
  }
  return flight.run(actionKey(gameId, a), async () => {
    const { fn, args } = rpcFor(gameId, a);
    let outcome: ActionOutcome;
    try {
      const { data, error } = await rpc(fn, args);
      if (error) outcome = outcomeOf(error, { courtLost });
      else if (a.kind === "join") outcome = { kind: "done", joined: data === "pending" ? "pending" : "accepted" };
      else outcome = { kind: "done" };
    } catch (e) {
      outcome = outcomeOf(e, { courtLost });
    }
    if (outcome.kind !== "signed-out") invalidateAfterGameChange(qc, gameId);
    return outcome;
  });
}

/** True while this action for this game is in flight (busy button ignores taps, §5.3). */
export function actionBusy(gameId: string, a: GameAction): boolean {
  return flight.busy(actionKey(gameId, a));
}

/**
 * Screen hook: `run(action)` and `busy(action)`. Re-renders when an action starts and ends.
 * The court-lost flag comes from the cached detail, so a `match_closed` refusal on a game whose
 * court booking was cancelled reads as the pause (GR-9), not as a generic closed game.
 */
export function useGameActions(gameId: string, opts: { available?: boolean } = {}) {
  const qc = useQueryClient();
  const [, setTick] = useState(0);
  const run = useCallback(async (a: GameAction) => {
    const detail = qc.getQueryData<{ court_lost?: boolean } | null>(gameKeys.detail(gameId));
    setTick((t) => t + 1);
    try {
      return await runGameAction(qc, gameId, a, { available: opts.available, courtLost: detail?.court_lost === true });
    } finally {
      setTick((t) => t + 1);
    }
  }, [qc, gameId, opts.available]);
  const busy = useCallback((a: GameAction) => actionBusy(gameId, a), [gameId]);
  return { run, busy };
}
