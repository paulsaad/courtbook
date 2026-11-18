import { NO_COURT, spots } from "./gameFormat";
import type { GameDetail } from "./gameTypes";

/**
 * Presentation of one game (docs/m3/03-journeys.md §3.0 GR-1…GR-12 and J2; 04-ux-spec.md §4.4).
 *
 * THIS IS NOT A PERMISSION CHECK. What a caller may see is decided by match_detail() (it returns no
 * row otherwise); what a caller may do is decided by join_match, leave_match, decide_join,
 * set_match_status, update_match and friends, which refuse with a reason. These helpers only choose
 * which buttons and sentences to show for the row the server already returned. A button shown here
 * can still be refused; the refusal is shown with gameFailure().
 */

export type Phase = "open" | "full" | "private" | "court_lost" | "playing" | "played" | "cancelled";
export type Role = "organiser" | "accepted" | "pending" | "waiting" | "declined" | "outsider";
export type Tone = "warn" | "ok" | "plain";
export type Banner = { kind: "court_lost" | "pending" | "waiting" | "accepted" | "declined"; tone: Tone; text: string };
export type Primary =
  | { kind: "join"; label: "Join" }
  | { kind: "ask"; label: "Ask to join" }
  | { kind: "chat"; label: "Chat" }
  | { kind: "resolve_court"; label: "Choose what to do" };
export type Secondary = "withdraw" | "leave" | "manage" | "hide" | "directions";

export type GameView = {
  phase: Phase;
  role: Role;
  statusLabel: string;
  isPrivate: boolean;
  courtLost: boolean;
  courtText: string;
  banners: Banner[];
  primary: Primary | null;
  secondary: Secondary[];
  /** Sentences shown before joining, in order (GR-10 no court; level outside range). */
  joinConfirm: string[];
  spots: ReturnType<typeof spots>;
  /** True when the player may see names (organiser and accepted players — match_participants' rule). */
  showsNames: boolean;
};

const STATUS_LABEL: Record<Phase, string> = {
  open: "Open", full: "Full", private: "Private", court_lost: "Court cancelled",
  playing: "Playing now", played: "Played", cancelled: "Cancelled",
};

/** GR-1: stored state + time. Order matters: cancelled, then time, then court, then closed reasons. */
export function phaseOf(d: Pick<GameDetail, "status" | "closed_reason" | "court_lost" | "started" | "finished">): Phase {
  if (d.status === "cancelled") return "cancelled";
  if (d.finished) return "played";
  if (d.started) return "playing";
  if (d.court_lost || d.closed_reason === "no_court") return "court_lost";
  if (d.status === "closed" && d.closed_reason === "full") return "full";
  if (d.status === "closed") return "private";
  return "open";
}

export function roleOf(d: Pick<GameDetail, "i_organize" | "my_status">, phase: Phase): Role {
  if (d.i_organize) return "organiser";
  if (d.my_status === "accepted") return "accepted";
  if (d.my_status === "pending") return phase === "full" ? "waiting" : "pending";
  if (d.my_status === "declined") return "declined";
  return "outsider";
}

function who(d: GameDetail): string {
  return d.organizer_name?.trim() || "The organiser";
}

export function gameView(d: GameDetail): GameView {
  const phase = phaseOf(d);
  const role = roleOf(d, phase);
  const org = who(d);
  const before = phase !== "playing" && phase !== "played" && phase !== "cancelled";
  const member = role === "organiser" || role === "accepted";
  const courtLost = phase === "court_lost" || (d.court_lost && before);
  const isPrivate = d.status === "closed" && d.closed_reason === "organizer";

  const banners: Banner[] = [];
  if (courtLost) banners.push({ kind: "court_lost", tone: "warn", text: `The court booking for this game was cancelled. Joining is paused until ${org === "The organiser" ? "the organiser" : org} decides.` });
  if (role === "pending") banners.push({ kind: "pending", tone: "warn", text: `Request sent — ${org} will accept or decline.` });
  if (role === "waiting") banners.push({ kind: "waiting", tone: "warn", text: `The game is full. You're on the waiting list — ${org} can still add you if a place opens.` });
  if (role === "accepted") banners.push({ kind: "accepted", tone: "ok", text: "You're in." });
  if (role === "declined") banners.push({ kind: "declined", tone: "plain", text: `${org} didn't accept you for this game.` });

  let primary: Primary | null = null;
  if (role === "organiser" && courtLost) primary = { kind: "resolve_court", label: "Choose what to do" };
  else if (member) primary = { kind: "chat", label: "Chat" };
  else if (role === "outsider" && phase === "open") primary = d.join_mode === "approval" ? { kind: "ask", label: "Ask to join" } : { kind: "join", label: "Join" };

  const secondary: Secondary[] = [];
  if ((role === "pending" || role === "waiting") && before) secondary.push("withdraw");
  if (role === "accepted" && before) secondary.push("leave");
  if (role === "organiser" && phase !== "cancelled" && phase !== "played") secondary.push("manage");
  if (member && (phase === "played" || phase === "cancelled")) secondary.push("hide");
  if (d.club_slug && phase !== "cancelled") secondary.push("directions");

  const joinConfirm: string[] = [];
  if (primary?.kind === "join" || primary?.kind === "ask") {
    if (!d.has_court) joinConfirm.push(`No court is booked through CourtBook for this game. ${org} says they are arranging the court. ${primary.kind === "ask" ? "Ask to join" : "Join"} anyway?`);
    const outside = d.my_level != null && d.level_min != null && d.level_max != null && (d.my_level < d.level_min || d.my_level > d.level_max);
    if (outside) joinConfirm.push(`This game is for levels ${d.level_min}–${d.level_max}. You're ${d.my_level}. ${primary.kind === "ask" ? "Ask to join" : "Join"} anyway?`);
  }

  return {
    phase, role, statusLabel: STATUS_LABEL[phase], isPrivate, courtLost,
    courtText: d.has_court && d.court_name ? d.court_name : NO_COURT,
    banners, primary, secondary, joinConfirm, spots: spots(d.players_needed, d.joined), showsNames: member,
  };
}

/** Sentence for a game the server did not return (GR-2): never says why, never confirms it exists. */
export const NOT_AVAILABLE = "This game isn't open any more, or isn't available to you.";

export type OrganiserAction = { kind: "edit" | "make_private" | "reopen" | "remove_player" | "cancel" | "resolve_court"; enabled: boolean; reason: string | null };

/**
 * The organiser's "Manage game" sheet (GR-8): items not allowed now stay visible but disabled, with
 * the reason. Display only — set_match_status, update_match, remove_player and resolve_court decide.
 * `remove_player` and `resolve_court` need migration M3-H (hardening).
 */
export function organiserActions(d: GameDetail): OrganiserAction[] {
  const phase = phaseOf(d);
  const started = phase === "playing" || phase === "played";
  const cancelled = phase === "cancelled";
  const courtLost = d.court_lost || d.closed_reason === "no_court";
  const isPrivate = d.status === "closed" && d.closed_reason === "organizer";
  const off = (reason: string) => ({ enabled: false, reason });
  const on = { enabled: true, reason: null };
  const timeOrCancel = cancelled ? off("This game was cancelled.") : started ? off("This game has already started.") : null;

  const actions: OrganiserAction[] = [
    { kind: "edit", ...(timeOrCancel ?? on) },
    isPrivate
      ? { kind: "reopen", ...(timeOrCancel ?? (courtLost ? off("Sort out the court first.") : on)) }
      : { kind: "make_private", ...(timeOrCancel ?? (courtLost ? off("Sort out the court first.") : on)) },
    { kind: "remove_player", ...(timeOrCancel ?? (d.joined === 0 ? off("No players have joined yet.") : on)) },
    { kind: "cancel", ...(cancelled ? off("This game was cancelled.") : phase === "played" ? off("This game has already been played.") : on) },
  ];
  if (courtLost && !cancelled && phase !== "played") actions.unshift({ kind: "resolve_court", ...on });
  return actions;
}
