import type { GameEdit } from "./gameActions";
import type { GameDetail } from "./gameTypes";

/**
 * Edit game limits, mirrored from update_match (0072) for display only — the function decides:
 * refused once the game is cancelled or has started (match_closed); players needed 1–30 and never
 * below the players already accepted (below_accepted).
 */
export function editLimits(d: Pick<GameDetail, "status" | "started" | "finished" | "joined">, now = Date.now(), startAt?: string) {
  const started = d.started || d.finished || (startAt != null && Date.parse(startAt) <= now);
  if (d.status === "cancelled") return { editable: false, reason: "This game was cancelled.", minPlayers: 1 };
  if (started) return { editable: false, reason: "This game has already started.", minPlayers: 1 };
  return { editable: true, reason: null, minPlayers: Math.max(1, d.joined) };
}

/** The status update_match leaves the game in (before any waiting request is accepted). */
function statusAfter(d: Pick<GameDetail, "status" | "closed_reason" | "joined">, needed: number): "open" | "closed" | "cancelled" {
  if (d.status === "open" && d.joined >= needed) return "closed";
  if (d.status === "closed" && d.closed_reason === "full" && d.joined < needed) return "open";
  return d.status;
}

/**
 * What switching Ask to join → Join straight away will do to waiting requests (S15, GR-4): while the
 * game takes players, they are accepted in the order they asked, up to the places left; the rest keep
 * waiting. Otherwise they keep waiting for the organiser's answer.
 */
export function editNote(d: Pick<GameDetail, "status" | "closed_reason" | "joined" | "pending" | "join_mode">, e: Pick<GameEdit, "joinMode" | "playersNeeded">): string | null {
  const waiting = d.pending ?? 0;
  if (!(d.join_mode === "approval" && e.joinMode === "open" && waiting > 0)) return null;
  const req = waiting === 1 ? "The 1 waiting request" : `The ${waiting} waiting requests`;
  if (statusAfter(d, e.playersNeeded) !== "open") return `${req} will keep waiting for your answer.`;
  const places = Math.max(0, e.playersNeeded - d.joined);
  if (places >= waiting) return `${req} will be accepted when you save.`;
  return `When you save, ${places === 1 ? "1 waiting player is" : `${places} waiting players are`} accepted in the order they asked. The others keep waiting for your answer.`;
}
