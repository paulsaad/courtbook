import { classify, type Failure } from "./errors";

/**
 * Game copy for every server reason Find a Game can meet (docs/m3/04-ux-spec.md §4.8).
 *
 * The app keeps its own sentences here because the web's table says "match" (the app says "game")
 * and its `not_found` is about payments. The web table is not changed. The KIND of failure still
 * comes from classify() — network / auth / refused / unknown — so retry and sign-in behaviour is
 * exactly the M2 behaviour.
 *
 * Reasons marked (0068) / (0069) are raised only once those migrations exist; listing them now
 * keeps the copy in one place and is harmless before then.
 */
export const GAME_ERRORS: Record<string, string> = {
  not_found: "This game isn't open any more, or isn't available to you.",
  forbidden: "Only the organiser can do that.",
  match_full: "This game just filled up.",
  match_closed: "This game is no longer open.",
  match_started: "This game has already started.",
  match_not_finished: "You can delete the conversation once the game is over.",
  join_declined: "The organiser didn't accept you for this game.",
  organizer_cannot_join: "You organise this game.",
  not_pending: "That request was withdrawn.",
  cannot_reopen: "A cancelled game can't be reopened.",
  below_accepted: "You already have more players accepted than that.",
  bad_players_needed: "Choose between 1 and 30 players.",
  bad_level_range: "Choose a level range from 1 to 10, or All levels welcome.",
  bad_level: "Choose a level range from 1 to 10, or All levels welcome.",
  bad_join_mode: "Something in the game details isn't right. Check and try again.",
  bad_range: "Something in the game details isn't right. Check and try again.",
  note_too_long: "Keep the note under 300 characters.",
  slot_in_past: "That time has passed.",
  booking_not_found: "Pick one of your own upcoming bookings.",
  booking_already_posted: "You already posted a game for this booking.",
  sport_mismatch: "That booking is for a different sport.",
  // (0068)
  club_required: "Choose a club for this game.",
  too_far_ahead: "Games can be posted up to 60 days ahead.",
  match_cancelled: "This game was cancelled.",
  match_over: "This game has already been played.",
  court_lost: "Sort out the court first: use another booking, go ahead without one, or cancel.",
  court_not_lost: "Something went wrong. Try again.",
  too_many_games: "You already have 10 open games. Close one to post another.",
  too_many_requests: "You have many requests waiting. Withdraw one to ask for another.",
  slow_down: "You're sending messages quickly. Wait a moment.",
  // (0069)
  blocked: "You can't join this game.",
  message_not_allowed: "This message can't be sent. Check our community rules.",
  rules_not_accepted: "Please accept the community rules first.",
  account_suspended: "Your account is suspended. Contact courtbook.contact@gmail.com.",
};

export const COURT_PAUSED = "Joining is paused: the court booking was cancelled.";

/** Longest first, so `booking_not_found` wins over `not_found` and `match_not_finished` over neither. */
const GAME_REASONS = Object.keys(GAME_ERRORS).sort((a, b) => b.length - a.length);

/** A reason appears as the whole message or as a word in it ("ERROR: match_full"). */
function findReason(message: string): string | undefined {
  return GAME_REASONS.find((r) => new RegExp(`(^|[^a-z_])${r}([^a-z_]|$)`).test(message));
}

/**
 * One failure → kind + one sentence, for game screens.
 * `courtLost`: the refetched detail says the court booking was cancelled, so a `match_closed`
 * refusal is explained as the pause (GR-9) rather than as a generic closed game.
 */
export function gameFailure(error: unknown, ctx: { courtLost?: boolean } = {}): Failure {
  const base = classify(error);
  if (base.kind === "auth" || base.kind === "network") return base;
  const e = (error ?? {}) as { message?: unknown };
  const message = typeof e.message === "string" ? e.message : String(error ?? "");
  const reason = findReason(message);
  if (!reason) return base.kind === "refused" ? base : { kind: "unknown", message: "Something went wrong. Try again." };
  if (reason === "match_closed" && ctx.courtLost) return { kind: "refused", message: COURT_PAUSED, reason };
  return { kind: "refused", message: GAME_ERRORS[reason], reason };
}
