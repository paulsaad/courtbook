import { useOnline } from "./online";
import { boardCard, gameWhen, joinModeLabel, type When } from "./gameFormat";
import { rangeLabel } from "@shared/levels";
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
  | { kind: "hero"; statusLabel: string; when: When; club: string | null; courtText: string; sport: string }
  | { kind: "banners"; banners: Banner[] }
  | { kind: "actions"; primary: Primary | null; secondary: Secondary[]; joinConfirm: string[]; notice: string | null }
  | { kind: "players"; spots: GameView["spots"]; names: ParticipantRow[] | null; organiser: string | null }
  | { kind: "requests"; rows: ParticipantRow[] }
  | { kind: "details"; level: string; joinMode: string; note: string | null; organiser: string | null }
  | { kind: "manage"; actions: OrganiserAction[] }
  | { kind: "report" };

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
    { kind: "hero", statusLabel: v.statusLabel, when: gameWhen(d.start_at, d.end_at, tz, o.now), club: d.club_name, courtText: v.courtText, sport: d.sport },
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
  out.push({ kind: "players", spots: v.spots, names: v.showsNames ? players : null, organiser });
  if (v.role === "organiser" && requests.length) out.push({ kind: "requests", rows: requests });
  out.push({ kind: "details", level: rangeLabel(d.level_min, d.level_max, d.level_legacy), joinMode: joinModeLabel(d.join_mode), note: d.note, organiser });
  if (v.role === "organiser" && o.writes && v.secondary.includes("manage")) out.push({ kind: "manage", actions: organiserActions(d) });
  if (v.role !== "organiser" && o.report) out.push({ kind: "report" });
  return out;
}

/** What the switches are today. Each turns on in the change that ships its stage. */
export const SCREEN_FEATURES: Omit<DetailOptions, "now"> = { writes: GAME_WRITES_AVAILABLE, chat: false, report: false };

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
  return { load, sections, actions, refetch: q.refetch };
}

/** Find a game: load state and one card model per game (§4.3), in the server's order. */
export function useFindGames(filters: GameFilters, { signedIn }: { signedIn: boolean }) {
  const online = useOnline();
  const q = useOpenGames(filters, { signedIn });
  const load: LoadView = loadView({
    signedIn, online, hasData: q.data !== undefined, isPending: q.isPending, fetchStatus: q.fetchStatus, error: q.error,
  });
  const cards = load.kind === "ready" ? (q.data ?? []).map((row) => ({ id: row.match_id, ...boardCard(row) })) : [];
  return { load, cards, empty: load.kind === "ready" && cards.length === 0, refetch: q.refetch };
}
