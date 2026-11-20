import { useCallback, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { clubLocalToUtc, hhmm, shiftDate, slotTimes, todayIn, toMin } from "@shared/time";
import { supabase } from "./supabase";
import type { Failure } from "./errors";
import { gameFailure } from "./gameErrors";
import { createSingleFlight } from "./singleFlight";
import { GAME_WRITES_AVAILABLE } from "./gameActions";
import { invalidateAfterGameChange } from "./games";
import type { JoinMode } from "./gameTypes";

/**
 * Post a game (docs/m3/03-journeys.md J6, 04-ux-spec.md §4.6). One call to the existing post_match,
 * under the player's own session. The server decides everything that matters — the booking is the
 * player's own, confirmed and not already posted; the sport matches the court; the start is in the
 * future and, without a booking, within 60 days; 1–30 players; at most 10 live games — and the screen
 * only shows its answer.
 *
 * Two paths, as on the website:
 *  A. from one of the player's own upcoming bookings: club, sport and time come from the booking;
 *  B. without a booking: club, sport, day, start time and length (60 / 90 / 120 min).
 */

export const DURATIONS = [60, 90, 120] as const;
export const MAX_PLAYERS = 30;
export const NOTE_MAX = 300;
/** post_match refuses a game without a booking starting 60 days or more from now (too_far_ahead). */
export const POST_DAYS = 60;

export type PostClub = {
  id: string; name: string; town: string | null; timezone: string;
  openTime: string; closeTime: string; slotMinutes: number; sports: string[];
};

export type PostBooking = {
  id: string; clubId: string; clubName: string; timezone: string; courtName: string | null; sport: string;
  startAt: string; endAt: string;
  /** a live game already uses this booking (post_match would answer booking_already_posted) */
  gameId: string | null;
};

export type PostDraft = {
  bookingId: string | null;
  clubId: string | null; sport: string | null; date: string | null; time: string | null; minutes: number;
  playersNeeded: number; levelMin: number | null; levelMax: number | null; joinMode: JoinMode; note: string;
};

/** The website's defaults: one player for a booking (the court is the organiser's), three otherwise; join straight away. */
export function initialDraft(bookingId: string | null = null, clubId: string | null = null): PostDraft {
  return {
    bookingId, clubId, sport: null, date: null, time: null, minutes: 90,
    playersNeeded: bookingId ? 1 : 3, levelMin: null, levelMax: null, joinMode: "open", note: "",
  };
}

/** Clubs a game can be posted at: active, with the sports of their active courts. */
export function usePostClubs(enabled = true) {
  return useQuery({
    queryKey: ["post-clubs"],
    enabled,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<PostClub[]> => {
      const { data, error } = await supabase
        .from("clubs")
        .select("id, name, timezone, open_time, close_time, slot_minutes, town:towns(name_en), courts(sport, active)")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return ((data ?? []) as unknown as {
        id: string; name: string; timezone: string; open_time: string; close_time: string; slot_minutes: number;
        town: { name_en: string } | null; courts: { sport: string; active: boolean }[] | null;
      }[]).map((c) => ({
        id: c.id, name: c.name, town: c.town?.name_en ?? null, timezone: c.timezone,
        openTime: c.open_time, closeTime: c.close_time, slotMinutes: c.slot_minutes,
        sports: [...new Set((c.courts ?? []).filter((x) => x.active).map((x) => x.sport))],
      })).filter((c) => c.sports.length > 0);
    },
  });
}

/** The player's own confirmed upcoming bookings (row-level security returns only theirs), each with its live game if any. */
export function usePostBookings(enabled = true) {
  return useQuery({
    queryKey: ["post-bookings"],
    enabled,
    queryFn: async (): Promise<PostBooking[]> => {
      const { data, error } = await supabase
        .from("bookings")
        .select("id, club_id, start_at, end_at, clubs(name, timezone), courts!bookings_court_id_fkey(name, sport)")
        .eq("status", "confirmed")
        .gt("start_at", new Date().toISOString())
        .order("start_at");
      if (error) throw error;
      const rows = (data ?? []) as unknown as {
        id: string; club_id: string; start_at: string; end_at: string;
        clubs: { name: string; timezone: string } | null; courts: { name: string; sport: string } | null;
      }[];
      const ids = rows.map((r) => r.id);
      const games = new Map<string, string>();
      if (ids.length) {
        const { data: m, error: e2 } = await supabase.from("matches").select("id, booking_id").in("booking_id", ids).neq("status", "cancelled");
        if (e2) throw e2;
        for (const g of (m ?? []) as { id: string; booking_id: string }[]) games.set(g.booking_id, g.id);
      }
      return rows.filter((r) => r.courts?.sport).map((r) => ({
        id: r.id, clubId: r.club_id, clubName: r.clubs?.name ?? "", timezone: r.clubs?.timezone ?? "Asia/Beirut",
        courtName: r.courts?.name ?? null, sport: r.courts!.sport, startAt: r.start_at, endAt: r.end_at,
        gameId: games.get(r.id) ?? null,
      }));
    },
  });
}

/** One line for a booking: "Padel 2 · Sat 21 Nov · 18:00–19:30 · Batroun Padel & Tennis Club". */
export function bookingLine(b: PostBooking): string {
  return [b.courtName, formatInTimeZone(new Date(b.startAt), b.timezone, "EEE d MMM"), `${hhmm(b.startAt, b.timezone)}–${hhmm(b.endAt, b.timezone)}`, b.clubName]
    .filter(Boolean).join(" · ");
}

/** Start times offered for a day: the club's grid (30 min when it books by the hour), the game must end by closing, and today only later times. */
export function startTimes(club: Pick<PostClub, "openTime" | "closeTime" | "slotMinutes" | "timezone">, date: string, minutes: number, now = new Date()): string[] {
  const step = club.slotMinutes > 0 && club.slotMinutes <= 30 ? club.slotMinutes : 30;
  const closeMin = club.closeTime.startsWith("24:") ? 1440 : toMin(club.closeTime);
  return slotTimes(club.openTime, club.closeTime, step)
    .filter((t) => toMin(t) + minutes <= closeMin)
    .filter((t) => clubLocalToUtc(date, t, club.timezone).getTime() > now.getTime());
}

/** The days a game without a booking can start on: today and the next POST_DAYS - 1 days (club time). */
export function postDays(tz: string): string[] {
  const today = todayIn(tz);
  return Array.from({ length: POST_DAYS }, (_, i) => shiftDate(today, i));
}

/** What is still missing before Post can be pressed (display only; the server checks everything again). */
export function missing(d: PostDraft): string | null {
  if (d.bookingId) return null;
  if (!d.sport) return "Choose a sport.";
  if (!d.clubId) return "Choose a club.";
  if (!d.date || !d.time) return "Choose a day and a start time.";
  return null;
}

/** post_match's arguments, in its own names. Pure, so both paths are unit-tested. */
export function postArgs(d: PostDraft, club: Pick<PostClub, "timezone"> | null, booking: Pick<PostBooking, "sport"> | null) {
  const note = d.note.trim();
  const common = {
    p_level_min: d.levelMin, p_level_max: d.levelMax, p_players_needed: d.playersNeeded,
    p_note: note === "" ? null : note, p_join_mode: d.joinMode,
  };
  if (d.bookingId) {
    // the server takes club, start and end from the booking; the sport must be the court's
    return { p_club: null, p_sport: booking?.sport ?? d.sport, p_start: null, p_end: null, p_booking: d.bookingId, ...common };
  }
  const start = clubLocalToUtc(d.date!, d.time!, club!.timezone);
  return {
    p_club: d.clubId, p_sport: d.sport, p_start: start.toISOString(), p_end: addMinutes(start, d.minutes).toISOString(),
    p_booking: null, ...common,
  };
}
export const POST_ARG_NAMES = ["p_club", "p_sport", "p_start", "p_end", "p_level_min", "p_level_max", "p_players_needed", "p_note", "p_booking", "p_join_mode"] as const;

/**
 * done       — posted (or found already posted after a lost answer: `recovered`).
 * existing   — the booking already has a live game (booking_already_posted): open that one.
 * refused    — the server said no; one sentence to show; nothing was created.
 * uncertain  — the call may have reached the server and the check could not tell. Post stays off
 *              until a check finds the game (done) or confirms there is none (then it can be retried).
 * signed-out — the session ended.
 */
export type PostOutcome =
  | { kind: "done"; gameId: string; recovered?: boolean }
  | { kind: "existing"; gameId: string; failure: Failure }
  | { kind: "refused"; failure: Failure }
  | { kind: "uncertain"; failure: Failure; since: Date }
  | { kind: "signed-out"; failure: Failure };

/** Shown when a check after a lost answer finds no game: nothing was created, so posting again is safe. */
export const NOT_POSTED = "Your game wasn't posted. Check your connection and try again.";
export const UNCERTAIN_POST = "We couldn't confirm whether your game was posted. Check again before posting.";

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
/** Looks for the game this post would have created; null = none; throws when it cannot tell. */
export type Lookup = (args: ReturnType<typeof postArgs>, since: Date) => Promise<string | null>;

/**
 * The game a lost answer may have created. With a booking, booking_match (one live game per booking,
 * enforced by a unique index). Without, the organiser's own live game at that club, sport and start,
 * created since the post began — post_match has no request token, so this is how a retry is kept
 * from making a second game (J6 "Network uncertain").
 */
export const defaultLookup: Lookup = async (args, since) => {
  if (args.p_booking) {
    const { data, error } = await supabase.rpc("booking_match", { p_booking: args.p_booking });
    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as { match_id: string } | null | undefined;
    return row?.match_id ?? null;
  }
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) throw new Error("not_authenticated");
  const { data, error } = await supabase
    .from("matches").select("id")
    .eq("organizer_id", user.user.id).eq("club_id", args.p_club!).eq("sport", args.p_sport!)
    .eq("start_at", args.p_start!).neq("status", "cancelled")
    .gte("created_at", new Date(since.getTime() - 60_000).toISOString())
    .order("created_at", { ascending: false }).limit(1);
  if (error) throw error;
  return (data?.[0] as { id: string } | undefined)?.id ?? null;
};

const flight = createSingleFlight();
export const POST_KEY = "post-game";

/** After an uncertain post: look again, never post again. */
export async function checkPost(qc: QueryClient, args: ReturnType<typeof postArgs>, since: Date, lookup: Lookup = defaultLookup): Promise<PostOutcome | { kind: "none" }> {
  try {
    const id = await lookup(args, since);
    if (id) { invalidateAfterGameChange(qc, id); return { kind: "done", gameId: id, recovered: true }; }
    return { kind: "none" };
  } catch (e) {
    return { kind: "uncertain", failure: { ...gameFailure(e), message: UNCERTAIN_POST }, since };
  }
}

/** Post once. Never throws. A second tap while the first is in flight gets the same promise. */
export async function postGame(
  qc: QueryClient, args: ReturnType<typeof postArgs>,
  opts: { available?: boolean; rpc?: Rpc; lookup?: Lookup; now?: () => Date } = {},
): Promise<PostOutcome> {
  const { available = GAME_WRITES_AVAILABLE, rpc = (fn, a) => supabase.rpc(fn, a), lookup = defaultLookup, now = () => new Date() } = opts;
  if (!available) return { kind: "refused", failure: { kind: "refused", message: "Posting games from the app arrives in the next update.", reason: "writes_unavailable" } };
  return flight.run(POST_KEY, async () => {
    const since = now();
    let error: unknown = null;
    let data: unknown = null;
    try {
      ({ data, error } = await rpc("post_match", args));
    } catch (e) {
      error = e;
    }
    if (!error && typeof data === "string") {
      invalidateAfterGameChange(qc, data);
      void qc.invalidateQueries({ queryKey: ["post-bookings"] });
      return { kind: "done", gameId: data };
    }
    const failure = gameFailure(error ?? new Error("no game id returned"));
    if (failure.kind === "auth") return { kind: "signed-out", failure };
    if (failure.kind === "refused" && failure.reason === "booking_already_posted" && args.p_booking) {
      try {
        const id = await lookup(args, since);
        if (id) return { kind: "existing", gameId: id, failure };
      } catch { /* fall through: the sentence alone */ }
      return { kind: "refused", failure };
    }
    if (failure.kind === "network" || !error) {
      // the answer was lost (or empty): find out, do not post again
      const checked = await checkPost(qc, args, since, lookup);
      if (checked.kind === "done" || checked.kind === "uncertain") return checked;
      return { kind: "refused", failure: { kind: "network", message: NOT_POSTED, reason: "not_posted" } };
    }
    return { kind: "refused", failure };
  });
}

export function postBusy(): boolean {
  return flight.busy(POST_KEY);
}

/** Screen hook: post, then check-only while the outcome is uncertain. */
export function usePostGame(opts: { available?: boolean } = {}) {
  const qc = useQueryClient();
  const [, setTick] = useState(0);
  const post = useCallback(async (args: ReturnType<typeof postArgs>) => {
    setTick((t) => t + 1);
    try { return await postGame(qc, args, { available: opts.available }); } finally { setTick((t) => t + 1); }
  }, [qc, opts.available]);
  const check = useCallback((args: ReturnType<typeof postArgs>, since: Date) => checkPost(qc, args, since), [qc]);
  return { post, check, busy: postBusy() };
}
