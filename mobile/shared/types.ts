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
  message_not_allowed: "This message can't be sent. Check the community rules.",
  bad_target: "You can't do that to your own account.",
  bad_reason: "Choose a reason for the report.",
  bad_status: "Choose handled or dismissed.",
  reason_required: "Enter a reason.",
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
};

// Longest first, so a code that contains another wins (`rules_not_accepted` over `not_accepted`,
// `user_not_found` over `not_found`), as the app's classify() already does.
const ERROR_KEYS = Object.keys(ERRORS).sort((a, b) => b.length - a.length);

export function friendlyError(message: string | undefined): string {
  if (!message) return "Something went wrong.";
  for (const key of ERROR_KEYS) if (message.includes(key)) return ERRORS[key];
  return message;
}

/** M3-S community rules, accepted once before a player's first chat message. DRAFT for Paul's review. */
export const COMMUNITY_RULES = [
  "Be civil. Treat other players as you would on court.",
  "No harassment, threats or abuse.",
  "Use the chat for the game you're playing.",
  "Use someone's contact details only for the game you're playing.",
  "Report anything that breaks these rules. We can remove messages and suspend accounts.",
];
