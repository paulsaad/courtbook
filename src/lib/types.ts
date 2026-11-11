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
  player_name?: string | null;
};

export type Block = { id: string; court_id: string; start_at: string; end_at: string; reason: string | null };

/** Database error names → what the desk sees */
export const ERRORS: Record<string, string> = {
  slot_taken: "That slot was just taken.",
  block_overlaps_booking: "There is a booking in that range. Cancel or move it first.",
  overlaps_existing_block: "That range is already blocked.",
  outside_opening_hours: "Outside opening hours.",
  not_on_grid: "Start time must be on the slot grid.",
  bad_duration: "Duration must be whole slots.",
  forbidden: "You are not allowed to do that.",
  not_started: "The booking has not started yet.",
  not_confirmed: "This booking is no longer active.",
  beyond_booking_window: "Too far ahead to book yet.",
  slot_in_past: "That time has passed.",
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
  bad_district: "Choose a district first.",
  bad_town_name: "Town name must be 2–60 characters.",
  bad_town: "That town does not exist.",
  too_long: "That booking is longer than the club allows.",
  club_not_found: "This club is not available.",
  not_found: "Payment not found — the hold may have expired. Go back and pick the slot again.",
  below_accepted: "You already have more accepted players than that.",
  user_not_found: "No account with that email. They need to sign in once first.",
  clubs_booking_minutes_check: "Min/max must be multiples of the grid step, and max ≥ min.",
  clubs_slot_minutes_check: "Grid step must be 30, 60 or 90.",
  clubs_booking_window_days_check: "Booking window must be 1–365 days.",
  clubs_hold_minutes_check: "Hold must be 2–30 minutes.",
};

export function friendlyError(message: string | undefined): string {
  if (!message) return "Something went wrong.";
  for (const key of Object.keys(ERRORS)) if (message.includes(key)) return ERRORS[key];
  return message;
}
