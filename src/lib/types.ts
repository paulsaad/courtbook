export type Club = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  slot_minutes: number;
  cancel_cutoff_hours: number;
  open_time: string;
  close_time: string;
  min_booking_minutes: number;
  max_booking_minutes: number;
  /** 'simulated' (hold then pay in the app) or 'at_desk' (confirmed at once, paid at the club) */
  payment_mode?: string | null;
};

export type Court = { id: string; name: string; sport: string; surface: string | null; sort: number; active: boolean };

export type Booking = {
  id: string;
  court_id: string | null;
  player_id: string | null;
  guest_name: string | null;
  guest_phone: string | null;
  start_at: string;
  end_at: string;
  status: "confirmed" | "cancelled" | "no_show" | "pending" | "expired";
  source: "app" | "staff";
  credit_tx_id: string | null;
  price_usd?: number | null;
  fee_usd?: number | null;
  hold_expires_at?: string | null;
  player_name?: string | null;
  /** staff only: guest phone, or the player's own, from club_booking_contacts */
  contact_phone?: string | null;
};

export type Block = { id: string; court_id: string; start_at: string; end_at: string; reason: string | null };

/** Database error names → what the desk sees */
export const ERRORS: Record<string, string> = {
  exceeds_balance: "That is more than this club is owed. Check the balance above — money that was never collected does not count.",
  never_collected: "This payment was never collected, so there is nothing to refund.",
  not_refund_due: "That payment is not awaiting a refund.",
  bad_amount: "Enter an amount greater than zero.",
  bad_method: "Choose a payment method from the list.",
  slot_taken: "That slot was just taken.",
  block_overlaps_booking: "There is a booking in that range. Cancel or move it first.",
  overlaps_existing_block: "That range is already blocked.",
  no_overlapping_blocks: "That range is already blocked.",
  outside_opening_hours: "Outside opening hours.",
  not_on_grid: "Start time must be on the slot grid.",
  bad_duration: "Duration must be whole slots, within what the club allows.",
  name_required: "Enter a name for the booking.",
  wrong_payment_mode: "This club takes payment at its desk — reserve without paying.",
  too_many_upcoming: "You already have the most bookings this club allows at once. Cancel one, or come back after your next game.",
  token_required: "Could not reserve. Try again.",
  court_not_found: "That court is not available at this club.",
  forbidden: "You are not allowed to do that.",
  not_started: "The booking has not started yet.",
  not_confirmed: "This booking is no longer active.",
  beyond_booking_window: "Too far ahead to book yet.",
  slot_in_past: "That time has passed.",
  walk_in_too_old: "A walk-in can be entered up to 2 hours after it started.",
  move_into_past: "A booking cannot be moved to a time that has passed.",
  booking_ended: "This booking has already ended and can't be moved.",
  simulated_demo_only: "Simulated payment is only for demo clubs. A real club takes payment at its desk.",
  no_price_rule: "No price set for this time. Ask the club.",
  price_rule_overlap: "Overlaps an existing rule for the same courts and days. Delete or narrow one of them.",
  not_payable: "This booking is no longer waiting for payment.",
  not_pending: "Only a pending request can be approved.",
  match_full: "This match just filled up.",
  match_closed: "This match is no longer open.",
  organizer_cannot_join: "You organise this match.",
  booking_not_found: "Pick one of your own upcoming bookings.",
  not_pending_join: "That request is no longer pending.",
  join_declined: "The organizer declined your request for this match.",
  sport_mismatch: "That booking is for a different sport.",
  booking_already_posted: "A match is already posted for that booking.",
  // M3-S (chat and player safety) refusals
  blocked: "You can't join this match.",
  account_suspended: "Your account is suspended. Contact courtbook.contact@gmail.com.",
  rules_not_accepted: "Please accept the community rules first.",
  age_not_confirmed: "CourtBook is for people aged 18 and over. Please confirm your age first: reload the page and you will be asked.",
  under_18: "CourtBook is only for people aged 18 and over.",
  message_not_allowed: "This message can't be sent. Check the community rules.",
  bad_target: "You can't do that to your own account.",
  bad_reason: "Choose a reason for the report.",
  bad_status: "Choose handled or dismissed.",
  reason_required: "Enter a reason.",
  text_required: "Write a few words first.",
  // M3-H (game hardening) refusals
  court_not_lost: "Something went wrong. Refresh and try again.",
  court_lost: "The court booking for this match was cancelled. Joining is paused until the organizer decides.",
  match_cancelled: "This match was cancelled.",
  match_over: "This match has already been played.",
  match_started: "This match has already started.",
  club_required: "Choose a club for this match.",
  too_far_ahead: "Matches can be posted up to 60 days ahead.",
  too_many_games: "You already have 10 matches coming up. Cancel one to post another.",
  too_many_requests: "You have 20 requests waiting. Withdraw one to ask for another.",
  slow_down: "You're sending messages quickly. Wait a moment.",
  not_accepted: "That player is no longer in this match.",
  bad_district: "Choose a district first.",
  bad_town_name: "Town name must be 2–60 characters.",
  bad_town: "That town does not exist.",
  too_long: "That booking is longer than the club allows.",
  club_not_found: "This club is not available.",
  not_found: "Payment not found — the hold may have expired. Go back and pick the slot again.",
  below_accepted: "You already have more accepted players than that.",
  bad_level: "Level must be between 1 and 10.",
  bad_level_range: "Choose a level range from 1 to 10 with min ≤ max, or All levels welcome.",
  user_not_found: "No account with that email. They need to sign in once first.",
  clubs_booking_minutes_check: "Min/max must be multiples of the grid step, and max ≥ min.",
  clubs_slot_minutes_check: "Grid step must be 30, 60 or 90.",
  clubs_booking_window_days_check: "Booking window must be 1–365 days.",
  clubs_hold_minutes_check: "Hold must be 2–30 minutes.",
  // W1 (audit B2): codes a user can trigger that used to show as raw text
  hold_already_active: "You already have a booking waiting to be paid. Finish or cancel it first.",
  hold_conflict: "You already have a booking waiting to be paid. Finish or cancel it first.",
  slot_blocked: "That time is blocked by the club.",
  gallery_full: "The gallery is full (6 photos). Remove one first.",
  caption_too_long: "A caption can be up to 80 characters.",
  note_too_long: "A note can be up to 300 characters.",
  cannot_reopen: "A cancelled game can't be reopened.",
  match_not_finished: "You can do this once the game has finished.",
  changed_elsewhere: "The photos were changed elsewhere. Refresh and try again.",
  bad_players_needed: "Choose between 1 and 30 players.",
  bad_range: "The end must be after the start.",
  // 0077: the database's own sentence for an outdated page, shown as written
  "CourtBook has been updated": "CourtBook has been updated. Reload the page, then block the time again.",
};

// Longest first, so a code that contains another wins (`rules_not_accepted` over `not_accepted`,
// `user_not_found` over `not_found`), as the app's classify() already does.
const ERROR_KEYS = Object.keys(ERRORS).sort((a, b) => b.length - a.length);

export function friendlyError(message: string | undefined): string {
  if (!message) return "Something went wrong.";
  for (const key of ERROR_KEYS) if (message.includes(key)) return ERRORS[key];
  // anything else is internal (a database or network message): never shown as is (W1, audit B2)
  return "Something went wrong. Refresh and try again.";
}

/** A refused block, in words about blocks: the database reuses the booking check's error names
 *  (staff_block, 0076), but a block has no minimum or maximum length, so "bad_duration" must not read as
 *  a booking-length rule. Everything else falls back to the shared list. */
export function blockErrorText(message: string | undefined, club: Pick<Club, "open_time" | "close_time" | "slot_minutes">): string {
  const m = message ?? "";
  const hours = `${club.open_time.slice(0, 5)}–${club.close_time.slice(0, 5)}`;
  if (m.includes("not_on_grid") || m.includes("bad_duration"))
    return `A block must start and end on the club's ${club.slot_minutes}-minute time grid.`;
  if (m.includes("outside_opening_hours")) return `A block must be within opening hours (${hours}), on one day.`;
  if (m.includes("slot_in_past")) return "That time has already passed. A block must end later than now.";
  return friendlyError(message);
}

/** Community rules, accepted once before a player's first chat message. Wording approved by Paul (20 Nov, revised). */
export const COMMUNITY_RULES_TITLE = "Community rules";
export const COMMUNITY_RULES = [
  "Keep it about sports. CourtBook is for finding players, booking courts and organising games.",
  "Respect others. Harassment, threats, insults and hate speech are not allowed.",
  "Respect personal boundaries. Don't make unwanted romantic or sexual advances toward other players.",
  "No advertising or solicitation. Do not use CourtBook to sell products, promote services, recruit people or ask for money.",
  "Respect privacy. Only use another player's contact information to arrange a game. If someone breaks these rules, report it. CourtBook may remove messages or suspend accounts.",
];
