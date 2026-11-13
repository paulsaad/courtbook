/**
 * Shapes returned by the same Supabase RPCs the web app calls. Kept as a
 * deliberate copy rather than a shared package: the proof of concept is meant
 * to prove the RPCs are reachable and correct from a native client, and a
 * shared module would hide a mismatch instead of exposing one.
 */

export type DaySlot = {
  club_id: string;
  club_name: string;
  slug: string;
  town: string | null;
  district: string | null;
  price_from: number | null;
  sports: string[];
  slot_minutes: number;
  min_minutes: number;
  max_minutes: number;
  service_fee_usd: number;
  hold_minutes: number;
  cancel_cutoff_hours: number;
  timezone: string;
  court_id: string;
  court_name: string;
  court_sport: string;
  start_at: string;
  free_minutes: number;
  is_demo: boolean | null;
};

export type ClubCard = {
  club_id: string;
  name: string;
  slug: string;
  town: string | null;
  district: string | null;
  governorate: string | null;
  sports: string[];
  price_from: number | null;
  next_free_at: string | null;
  next_free_court: string | null;
  next_free_court_id: string | null;
  location_url: string | null;
  cover_url: string | null;
  is_demo: boolean | null;
  open_time: string;
  close_time: string;
};
