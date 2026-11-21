/** Bookings list: every row shows its state in colour AND words (green confirmed, red cancelled, neutral past). */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null }, useFocusEffect: jest.fn() }));
import { render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { rowStatus, type AgendaRow } from "../lib/bookings";
import { Row, TONE } from "../app/(tabs)/bookings";
import { color } from "../lib/theme";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const base: AgendaRow = { kind: "booking", id: "b1", start_at: "2026-11-22T16:00:00Z", end_at: "2026-11-22T17:30:00Z",
  club_name: "Batroun Padel & Tennis Club", club_slug: "batroun", timezone: "Asia/Beirut", title: "Court 1", status: "confirmed", role: "player" };
const past = { start_at: "2026-11-20T16:00:00Z", end_at: "2026-11-20T17:30:00Z" };

describe("rowStatus (display only)", () => {
  it.each([
    ["upcoming confirmed booking", base, "confirmed", "Confirmed"],
    ["cancelled booking (upcoming)", { ...base, status: "cancelled" }, "cancelled", "Cancelled"],
    ["cancelled booking (past)", { ...base, ...past, status: "cancelled" }, "cancelled", "Cancelled"],
    ["finished confirmed booking", { ...base, ...past }, "past", "Completed"],
    ["no-show", { ...base, ...past, status: "no_show" }, "past", "No-show"],
    ["game you are in", { ...base, kind: "match", status: "open", role: "accepted" }, "confirmed", "You're in"],
    ["game you organise", { ...base, kind: "match", status: "closed", role: "organizer" }, "confirmed", "You're organising"],
    ["game request waiting", { ...base, kind: "match", status: "open", role: "pending" }, "waiting", "Waiting for the organiser"],
    ["cancelled game", { ...base, kind: "match", status: "cancelled", role: "accepted" }, "cancelled", "Cancelled"],
    ["finished game", { ...base, ...past, kind: "match", status: "closed", role: "accepted" }, "past", "Played"],
  ] as const)("%s", (_n, r, tone, label) => {
    expect(rowStatus(r as AgendaRow, NOW)).toEqual({ tone, label });
  });
});

const flat = (s: unknown) => StyleSheet.flatten(s as never) as Record<string, unknown>;

describe("Row shows colour and words", () => {
  it.each([
    ["confirmed", base, "Confirmed", color.cedar],
    ["cancelled", { ...base, status: "cancelled" }, "Cancelled", color.danger],
    ["past", { ...base, ...past }, "Completed", color.line],
  ] as const)("%s", async (_n, r, word, edge) => {
    await render(<Row r={r as AgendaRow} now={NOW} />);
    expect(screen.getByText(word)).toBeTruthy();
    expect(flat(screen.getByTestId("row-edge").props.style).backgroundColor).toBe(edge);
    expect(screen.getByRole("button").props.accessibilityLabel).toContain(word);
  });
  it("cancelled uses the error red, never the brand red (design rule)", () => {
    expect(TONE.cancelled.edge).toBe(color.danger);
    expect(Object.values(TONE).flatMap((t) => Object.values(t))).not.toContain(color.red);
  });
});

describe("unknown statuses and roles never show green (fallback: neutral \"See details\")", () => {
  it.each([
    ["booking held for payment (pending)", { ...base, status: "pending" }],
    ["booking hold expired", { ...base, status: "expired" }],
    ["booking with a status added later", { ...base, status: "rescheduled" }],
    ["finished booking with an unknown status", { ...base, ...past, status: "rescheduled" }],
    ["game with an unknown role", { ...base, kind: "match", status: "open", role: "declined" }],
    ["game with no role", { ...base, kind: "match", status: "open", role: null }],
    ["game with a status added later", { ...base, kind: "match", status: "paused", role: "accepted" }],
    ["finished game with an unknown status", { ...base, ...past, kind: "match", status: "paused", role: "accepted" }],
  ] as const)("%s", async (_n, r) => {
    expect(rowStatus(r as AgendaRow, NOW)).toEqual({ tone: "past", label: "See details" });
    await render(<Row r={r as AgendaRow} now={NOW} />);
    expect(screen.getByText("See details")).toBeTruthy();
    expect(flat(screen.getByTestId("row-edge").props.style).backgroundColor).not.toBe(color.cedar);
    expect(screen.getByRole("button").props.accessibilityLabel).toContain("See details");
  });
});
