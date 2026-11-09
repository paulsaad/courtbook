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
  status: "confirmed" | "cancelled" | "no_show";
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
};

export function friendlyError(message: string | undefined): string {
  if (!message) return "Something went wrong.";
  for (const key of Object.keys(ERRORS)) if (message.includes(key)) return ERRORS[key];
  return message;
}
