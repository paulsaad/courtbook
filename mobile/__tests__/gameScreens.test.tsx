jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), auth: { signOut: jest.fn() } } }));
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import { CHAT_LATER_TEXT, detailSections, SCREEN_FEATURES, useFindGames, useGameScreen, type DetailOptions, type DetailSection } from "../lib/gameScreens";
import { JOIN_LATER_TEXT, MANAGE_LATER_TEXT } from "../lib/gameActions";
import { DEFAULT_FILTERS } from "../lib/gameFilters";
import { NO_COURT } from "../lib/gameFormat";
import type { GameDetail, ParticipantRow } from "../lib/gameTypes";

// Screen structure (04-ux-spec §4.3–4.4, 07-roadmap §7.2): which sections, in which order, saying
// what. Display only — every action is decided again by the database.

const base: GameDetail = {
  match_id: "m1", club_id: "c1", club_name: "Batroun Padel & Tennis", club_slug: "batroun", club_timezone: "Asia/Beirut", town: "Batroun",
  sport: "padel", start_at: "2026-11-21T16:00:00Z", end_at: "2026-11-21T17:30:00Z",
  level_min: 4, level_max: 6, level_legacy: false, my_level: 5, players_needed: 3, joined: 1, pending: null,
  status: "open", closed_reason: null, court_lost: false, note: "Friendly doubles", join_mode: "approval",
  organizer_id: null, organizer_name: "Rami", my_status: null, i_organize: false,
  has_court: true, booking_id: null, court_name: "Court 2", started: false, finished: false, hidden: false,
};
const g = (over: Partial<GameDetail>): GameDetail => ({ ...base, ...over });
const person = (id: string, status: "accepted" | "pending", organiser = false): ParticipantRow =>
  ({ profile_id: id, name: id, level: 5, level_legacy: null, is_organizer: organiser, status });
const PEOPLE = [person("Rami", "accepted", true), person("Adam", "accepted"), person("Bana", "pending")];

const STAGE1: DetailOptions = { writes: false, chat: false, report: false };
const LATER: DetailOptions = { writes: true, chat: true, report: true };
const kinds = (s: DetailSection[]) => s.map((x) => x.kind);
const pick = <K extends DetailSection["kind"]>(s: DetailSection[], k: K) => s.find((x) => x.kind === k) as Extract<DetailSection, { kind: K }> | undefined;

describe("section order follows §4.4", () => {
  it("organiser, everything shipped: hero, banners, actions, players, requests, details, manage", () => {
    const s = detailSections(g({ i_organize: true, organizer_id: "o", pending: 1, court_lost: true, status: "closed", closed_reason: "no_court" }), PEOPLE, LATER);
    expect(kinds(s)).toEqual(["hero", "banners", "actions", "players", "requests", "details", "resolve", "manage"]);
  });
  it("a player, everything shipped: report last, no requests, no manage", () => {
    expect(kinds(detailSections(g({ my_status: "accepted" }), PEOPLE, LATER))).toEqual(["hero", "banners", "actions", "players", "details", "report"]);
  });
  it("a stranger on an open game: no banners section when there is nothing to say", () => {
    expect(kinds(detailSections(g({}), [], STAGE1))).toEqual(["hero", "actions", "players", "details"]);
  });
});

describe("stage 1 is read-only (§7.2)", () => {
  it("is what the switches say today", () => {
    expect(SCREEN_FEATURES).toEqual({ writes: false, chat: false, report: false });
  });
  it("a stranger sees the joining sentence instead of a button", () => {
    const a = pick(detailSections(g({}), [], STAGE1), "actions")!;
    expect(a.primary).toBeNull();
    expect(a.notice).toBe(JOIN_LATER_TEXT);
    expect(a.joinConfirm).toEqual([]);
  });
  it("a member sees the chat sentence; leave is not offered", () => {
    const a = pick(detailSections(g({ my_status: "accepted" }), PEOPLE, STAGE1), "actions")!;
    expect(a.primary).toBeNull();
    expect(a.notice).toBe(CHAT_LATER_TEXT);
    expect(a.secondary).toEqual(["directions"]);
  });
  it("the organiser sees the managing sentence and no manage section", () => {
    const s = detailSections(g({ i_organize: true, pending: 1 }), PEOPLE, STAGE1);
    expect(pick(s, "actions")!.notice).toBe(MANAGE_LATER_TEXT);
    expect(pick(s, "manage")).toBeUndefined();
    expect(pick(s, "requests")!.rows.map((r) => r.profile_id)).toEqual(["Bana"]);   // requests are readable
  });
  it("a requester sees the request banner and no withdraw yet", () => {
    const s = detailSections(g({ my_status: "pending" }), [], STAGE1);
    expect(pick(s, "banners")!.banners[0].kind).toBe("pending");
    expect(pick(s, "actions")!.secondary).not.toContain("withdraw");
  });
});

describe("once writes ship", () => {
  it("ask to join with its confirmations (no court, level outside the range)", () => {
    const a = pick(detailSections(g({ has_court: false, court_name: null, my_level: 8 }), [], LATER), "actions")!;
    expect(a.primary).toEqual({ kind: "ask", label: "Ask to join" });
    expect(a.joinConfirm).toHaveLength(2);
    expect(a.notice).toBeNull();
  });
  it("court booking cancelled: the organiser's primary action is to choose what to do", () => {
    const a = pick(detailSections(g({ i_organize: true, status: "closed", closed_reason: "no_court", court_lost: true }), [], LATER), "actions")!;
    expect(a.primary).toEqual({ kind: "resolve_court", label: "Choose what to do" });
  });
});

describe("content", () => {
  it("names only for the organiser and accepted players; others get counts and the organiser's name", () => {
    expect(pick(detailSections(g({}), [], STAGE1), "players")!.names).toBeNull();
    expect(pick(detailSections(g({}), [], STAGE1), "players")!.organiser).toBe("Rami");
    expect(pick(detailSections(g({ my_status: "accepted" }), PEOPLE, STAGE1), "players")!.names!.map((p) => p.profile_id)).toEqual(["Rami", "Adam"]);
  });
  it("hero: status, day and time in the club's time zone, and the no-court wording (P1)", () => {
    const h = pick(detailSections(g({ has_court: false, court_name: null }), [], { ...STAGE1, now: new Date("2026-11-19T10:00:00Z") }), "hero")!;
    expect(h.statusLabel).toBe("Open");
    expect(h.when.time).toBe("18:00–19:30");
    expect(h.courtText).toBe(NO_COURT);
  });
  it("details: level range, join mode, note, organiser", () => {
    expect(pick(detailSections(g({}), [], STAGE1), "details")).toEqual(
      { kind: "details", level: "Levels 4–6", joinMode: "Ask to join", note: "Friendly doubles", organiser: "Rami", fit: { text: "You're Level 5 · fits", tone: "ok" } });
  });
});

describe("screen hooks make no game call when signed out (U9)", () => {
  const rpc = supabase.rpc as jest.Mock;
  beforeEach(() => rpc.mockReset());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })}>{children}</QueryClientProvider>
  );
  it("game and board", async () => {
    const a = await renderHook(() => useGameScreen("m1", { signedIn: false }), { wrapper });
    const b = await renderHook(() => useFindGames(DEFAULT_FILTERS, { signedIn: false }), { wrapper });
    expect(a.result.current.load.kind).toBe("signed-out");
    expect(a.result.current.sections).toBeNull();
    expect(b.result.current.load.kind).toBe("signed-out");
    expect(b.result.current.cards).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
