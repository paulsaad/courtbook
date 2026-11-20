import { useOnline } from "./online";
import { formatInTimeZone } from "date-fns-tz";
import { boardCard, gameWhen, joinModeLabel, type When } from "./gameFormat";
import { fitLabel, rangeLabel } from "@shared/levels";
import { BEIRUT, localDate } from "./gameFilters";
import { shiftDate } from "@shared/time";
import type { GameFilters } from "./gameFilters";
import { gameView, organiserActions, type Banner, type GameView, type OrganiserAction, type Primary, type Secondary } from "./gameState";
import { loadView, splitPeople, useGame, useGamePeople, useOpenGames, type LoadView } from "./games";
import { GAME_WRITES_AVAILABLE, JOIN_LATER_TEXT, MANAGE_LATER_TEXT, useGameActions } from "./gameActions";
import type { GameDetail, ParticipantRow } from "./gameTypes";

/**
 * Screen structure for Find a game and Game (docs/m3/04-ux-spec.md §4.3–4.4, 07-roadmap.md §7.2).
 *
 * CONTENT AND ORDER ONLY. These functions say which sections a screen has, in which order, and what
 * each one says — all from the approved spec. How they look (layout, sizes, spacing, hierarchy) is
 * the Stitch review's job and is NOT decided here: no screen uses this until Paul approves the board
 * and detail designs. Permissions stay on the server (see gameState.ts).
 */

/** Stage 1 is read-only (§7.2): these replace the actions until writes and chat ship. */
export const CHAT_LATER_TEXT = "Chat arrives in a later update.";

export type DetailSection =
  | { kind: "hero"; statusLabel: string; when: When; dateLine: string; minutes: number | null; levels: string | null;
      club: string | null; town: string | null; courtText: string; booked: boolean; courtLost: boolean; sport: string; phase: GameView["phase"] }
  | { kind: "banners"; banners: Banner[] }
  | { kind: "actions"; primary: Primary | null; secondary: Secondary[]; joinConfirm: string[]; notice: string | null }
  | { kind: "players"; spots: GameView["spots"]; names: ParticipantRow[] | null; organiser: string | null; paused: boolean; privacyNote: string | null }
  | { kind: "requests"; rows: ParticipantRow[] }
  | { kind: "details"; level: string; joinMode: string; note: string | null; organiser: string | null; fit: ReturnType<typeof fitLabel> }
  | { kind: "resolve"; club: string | null; choices: ResolveChoice[]; enabled: boolean }
  | { kind: "manage"; actions: OrganiserAction[] }
  | { kind: "report" };

/**
 * GR-9: the organiser's three ways out when the court booking was cancelled. Nothing books a court:
 * "link" attaches another booking the organiser already holds; "without" carries on with no court
 * booked through CourtBook (P1); "cancel" ends the game.
 */
export type ResolveChoice = { kind: "link" | "without" | "cancel"; label: string; hint: string };
export const RESOLVE_CHOICES: ResolveChoice[] = [
  { kind: "link", label: "Link another existing booking", hint: "Choose one of your confirmed bookings for this sport. No new court is booked." },
  { kind: "without", label: "Proceed without a CourtBook reservation", hint: "The game goes ahead. It will show “No court booked through CourtBook”." },
  { kind: "cancel", label: "Cancel this game", hint: "Everyone in the game and everyone waiting is told." },
];

/** "Saturday 21 November", or "Today, 21 November" / "Tomorrow, 22 November", in the club's zone. */
export function heroDate(startAt: string, tz: string = BEIRUT, now: Date = new Date()): string {
  const date = formatInTimeZone(new Date(startAt), tz, "yyyy-MM-dd");
  const today = localDate(now, tz);
  const rest = formatInTimeZone(new Date(startAt), tz, "d MMMM");
  if (date === today) return `Today, ${rest}`;
  if (date === shiftDate(today, 1)) return `Tomorrow, ${rest}`;
  return formatInTimeZone(new Date(startAt), tz, "EEEE d MMMM");
}

/** Length in minutes, or null when the game has no end time. */
export function gameMinutes(startAt: string, endAt: string | null): number | null {
  if (!endAt) return null;
  const m = Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60_000);
  return m > 0 ? m : null;
}

export type DetailOptions = {
  /** Game actions switched on (M3-H approved and applied; GAME_WRITES_AVAILABLE). */
  writes: boolean;
  /** Chat screen shipped (stage 4). */
  chat: boolean;
  /** Report a game (M3-S, stage 4). */
  report: boolean;
  now?: Date;
};

const SECONDARY_NEEDS_WRITES = new Set<Secondary>(["withdraw", "leave", "manage", "hide"]);

/**
 * §4.4, in order: 1 hero · 2 banners · 3 primary and secondary actions · 4 players · 5 requests
 * (organiser) · 6 details · 7 manage (organiser) · 8 report (not the organiser).
 * `people` is match_participants: the server returns names only to the organiser and accepted
 * players; for anyone else it is empty and only counts are shown.
 */
export function detailSections(d: GameDetail, people: ParticipantRow[] | undefined, o: DetailOptions): DetailSection[] {
  const v = gameView(d);
  const tz = d.club_timezone ?? undefined;
  const organiser = d.organizer_name?.trim() || null;
  const out: DetailSection[] = [
    {
      kind: "hero", statusLabel: v.statusLabel, when: gameWhen(d.start_at, d.end_at, tz, o.now), dateLine: heroDate(d.start_at, tz ?? BEIRUT, o.now),
      minutes: gameMinutes(d.start_at, d.end_at), levels: d.level_min != null && d.level_max != null ? rangeLabel(d.level_min, d.level_max, d.level_legacy) : null,
      club: d.club_name, town: d.town, courtText: v.courtText, booked: d.has_court && !!d.court_name, courtLost: v.courtLost, sport: d.sport, phase: v.phase,
    },
  ];
  if (v.banners.length) out.push({ kind: "banners", banners: v.banners });

  // actions: the full set once writes ship; before then, the stage-1 sentence in their place
  let primary = v.primary;
  let notice: string | null = null;
  if (primary?.kind === "chat" && !o.chat) { primary = null; notice = CHAT_LATER_TEXT; }
  if ((primary?.kind === "join" || primary?.kind === "ask") && !o.writes) { primary = null; notice = JOIN_LATER_TEXT; }
  if (primary?.kind === "resolve_court" && !o.writes) { primary = null; notice = MANAGE_LATER_TEXT; }
  if (v.role === "organiser" && !o.writes) notice = MANAGE_LATER_TEXT;   // §7.2: the organiser's sentence wins
  const secondary = v.secondary.filter((s) => o.writes || !SECONDARY_NEEDS_WRITES.has(s));
  out.push({ kind: "actions", primary, secondary, joinConfirm: primary ? v.joinConfirm : [], notice });

  const { players, requests } = splitPeople(people ?? []);
  const privacyNote = v.showsNames ? null
    : v.role === "pending" || v.role === "waiting" ? "Names show once you're in the game."
    : "Only players in the game see who is playing.";
  out.push({ kind: "players", spots: v.spots, names: v.showsNames ? players : null, organiser, paused: v.courtLost, privacyNote });
  if (v.role === "organiser" && requests.length) out.push({ kind: "requests", rows: requests });
  out.push({ kind: "details", level: rangeLabel(d.level_min, d.level_max, d.level_legacy), joinMode: joinModeLabel(d.join_mode), note: d.note, organiser, fit: fitLabel(d.my_level, d.level_min, d.level_max) });
  if (v.role === "organiser" && v.courtLost) out.push({ kind: "resolve", club: d.club_name, choices: RESOLVE_CHOICES, enabled: o.writes });
  if (v.role === "organiser" && o.writes && v.secondary.includes("manage")) out.push({ kind: "manage", actions: organiserActions(d) });
  if (v.role !== "organiser" && o.report) out.push({ kind: "report" });
  return out;
}

/** What the switches are today. Each turns on in the change that ships its stage. */
/** Writes and chat: on where 0072 is applied (staging). Report needs M3-S (not applied). */
export const SCREEN_FEATURES: Omit<DetailOptions, "now"> = { writes: GAME_WRITES_AVAILABLE, chat: GAME_WRITES_AVAILABLE, report: false };

/** Game screen: load state, sections and actions for one game id. */
export function useGameScreen(id: string | undefined, { signedIn }: { signedIn: boolean }) {
  const online = useOnline();
  const q = useGame(id, { signedIn });
  const detail = q.data ?? null;
  const namesVisible = !!detail && (detail.i_organize || detail.my_status === "accepted");
  const people = useGamePeople(id, { signedIn, visible: namesVisible });
  const actions = useGameActions(id ?? "", { available: SCREEN_FEATURES.writes });
  const load: LoadView = loadView({
    signedIn, online, hasData: q.data !== undefined, dataIsNull: q.data === null,
    isPending: q.isPending, fetchStatus: q.fetchStatus, error: q.error,
  });
  const sections = load.kind === "ready" && detail ? detailSections(detail, people.data, SCREEN_FEATURES) : null;
  const refetch = () => { void q.refetch(); if (namesVisible) void people.refetch(); };
  return { load, detail, sections, actions, refetch, refreshing: q.isRefetching || people.isRefetching };
}

/** Find a game: load state and one card model per game (§4.3), in the server's order. */
export function useFindGames(filters: GameFilters, { signedIn }: { signedIn: boolean }) {
  const online = useOnline();
  const q = useOpenGames(filters, { signedIn });
  const load: LoadView = loadView({
    signedIn, online, hasData: q.data !== undefined, isPending: q.isPending, fetchStatus: q.fetchStatus, error: q.error,
  });
  const rows = load.kind === "ready" ? q.data ?? [] : [];
  const cards = rows.map((row) => ({ id: row.match_id, ...boardCard(row) }));
  return {
    load, rows, cards, empty: load.kind === "ready" && rows.length === 0, refetch: q.refetch,
    updatedAt: q.dataUpdatedAt, fetching: q.isFetching, refreshing: q.isRefetching,
  };
}
