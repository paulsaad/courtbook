/**
 * Galaxy A17 acceptance (23 Nov): a cancelled game's status was a muted grey-green pill on the Game screen, hard to
 * tell from an active game. A cancelled game now wears a solid red badge with white text (CANCELLED_BADGE) on the
 * Game screen and in Bookings → Games. Every other status keeps its style. Visual only: no logic changes.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), replace: jest.fn() }, Stack: { Screen: () => null } }));

import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { render, screen, within } from "@testing-library/react-native";
import { GameDetailView } from "../components/game/GameDetailView";
import { detailSections } from "../lib/gameScreens";
import { Row, TONE } from "../app/(tabs)/bookings";
import { CANCELLED_BADGE, color } from "../lib/theme";
import { rowStatus, type AgendaRow } from "../lib/bookings";
import type { GameDetail } from "../lib/gameTypes";

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const wrap = (ui: ReactNode) => <SafeAreaProvider initialMetrics={metrics}>{ui}</SafeAreaProvider>;
const NOW = new Date("2026-11-23T10:00:00Z");
const OPTS = { writes: false, chat: false, report: false, now: NOW };
const base: GameDetail = {
  match_id: "m1", club_id: "c1", club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", club_timezone: "Asia/Beirut", town: "Batroun",
  sport: "padel", start_at: "2026-11-25T16:00:00Z", end_at: "2026-11-25T17:30:00Z",
  level_min: 4, level_max: 6, level_legacy: false, my_level: 5, players_needed: 3, joined: 1, pending: null,
  status: "open", closed_reason: null, court_lost: false, note: null, join_mode: "approval",
  organizer_id: null, organizer_name: "Rami", my_status: "accepted", i_organize: false,
  has_court: true, booking_id: null, court_name: "Court 2", started: false, finished: false, hidden: false,
};
const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style);
const textOf = (id: string, label: string) => within(screen.getByTestId(id)).getByText(label);

async function hero(o: Partial<GameDetail>) {
  await render(wrap(<GameDetailView sections={detailSections({ ...base, ...o }, undefined, OPTS)} me="me" pendingCount={null} handlers={{}} />));
}

describe("Game screen: the status pill", () => {
  it("Cancelled: solid status red with white text", async () => {
    await hero({ status: "cancelled" });
    expect(screen.getByTestId("game-status")).toHaveTextContent("Cancelled");
    expect(flat("game-status").backgroundColor).toBe(CANCELLED_BADGE.backgroundColor);
    expect(textOf("game-status", "Cancelled")).toHaveStyle({ color: CANCELLED_BADGE.text });
    expect(CANCELLED_BADGE).toEqual({ backgroundColor: color.danger, borderColor: color.danger, text: "#FFFFFF" });
  });

  it.each([
    ["Open", {}],
    ["Full", { status: "closed" as const, closed_reason: "full" as const }],
    ["Private", { status: "closed" as const, closed_reason: null }],
    ["Court cancelled", { court_lost: true }],                                      // the court was lost; the game is not cancelled
    ["Playing now", { start_at: "2026-11-23T09:30:00Z", end_at: "2026-11-23T11:00:00Z", started: true }],
    ["Played", { start_at: "2026-11-22T09:30:00Z", end_at: "2026-11-22T11:00:00Z", started: true, finished: true }],
  ])("%s keeps the existing translucent pill", async (label, o) => {
    await hero(o as Partial<GameDetail>);
    expect(screen.getByTestId("game-status")).toHaveTextContent(label);
    expect(flat("game-status").backgroundColor).toBe("rgba(255,255,255,0.14)");
    expect(textOf("game-status", label)).toHaveStyle({ color: color.onDark });
  });
});

describe("Bookings → Games: the row's status chip", () => {
  const row = (o: Partial<AgendaRow>): AgendaRow => ({
    kind: "match", id: "m1", start_at: "2026-11-25T16:00:00Z", end_at: "2026-11-25T17:30:00Z", club_name: "Batroun Padel & Tennis Club",
    club_slug: "batroun", timezone: "Asia/Beirut", title: "Padel match", status: "open", role: "player", ...o,
  } as AgendaRow);

  it("a cancelled game: solid status red with white text, the same badge as the Game screen", async () => {
    await render(<Row r={row({ status: "cancelled" })} past now={NOW.getTime()} />);
    expect(screen.getByTestId("row-status")).toHaveTextContent("Cancelled");
    expect(flat("row-status").backgroundColor).toBe(CANCELLED_BADGE.backgroundColor);
    expect(textOf("row-status", "Cancelled")).toHaveStyle({ color: CANCELLED_BADGE.text });
  });

  it("an active game keeps its chip", async () => {
    const r = row({ status: "open" });
    await render(<Row r={r} now={NOW.getTime()} />);
    const tone = TONE[rowStatus(r, NOW.getTime()).tone];
    expect(flat("row-status").backgroundColor).toBe(tone.fill);
    expect(flat("row-status").backgroundColor).not.toBe(CANCELLED_BADGE.backgroundColor);
  });

  it("a cancelled court booking is unchanged (only game status was asked for)", async () => {
    await render(<Row r={row({ kind: "booking", title: null, status: "cancelled" })} past now={NOW.getTime()} />);
    expect(flat("row-status").backgroundColor).toBe(TONE.cancelled.fill);
    expect(textOf("row-status", "Cancelled")).toHaveStyle({ color: TONE.cancelled.text });
  });
});
