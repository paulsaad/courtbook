/**
 * Largest-text findings from the Galaxy A17 (18 Nov, F1–F4). Android reports a cut-off text's full
 * string to the test tools, so truncation cannot be asserted on the device; these tests pin the
 * causes instead, and the emulator screenshots at 360 dp × text 1.6 and 2.0 show the result.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })), getSession: jest.fn(async () => ({ data: { session: null } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null }, useFocusEffect: jest.fn() }));
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
const dims = { width: 360, height: 800, scale: 3, fontScale: 1 };
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({ __esModule: true, default: () => dims }));

import { Platform } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { ClubCard, PRICE_BESIDE_NAME_MAX_SCALE } from "../app/(tabs)/courts";
import { Row } from "../app/(tabs)/bookings";
import { TimeTile, tileLabel, SELECTED_WORD_MAX_SCALE } from "../components/TimeTile";
import { HEADER_MAX_FONT_SCALE, WrappingHeaderTitle, wrappingTitle } from "../components/HeaderTitle";

const LONG = "Batroun Padel & Tennis Club of North Lebanon";
afterEach(() => { dims.fontScale = 1; });

describe("F1 Courts card", () => {
  it("shows the club name with no line limit", async () => {
    const club = { id: "c1", name: LONG, slug: "b", town: "Batroun", priceFrom: 20, timezone: "Asia/Beirut", slotMinutes: 30, minMinutes: 60, maxMinutes: 120, cancelCutoffHours: 6, isDemo: false, courtCount: 5, sports: ["padel"], starts: [] };
    await render(<ClubCard club={club} date="2026-11-19" sport={null} cover={null} />);
    expect(screen.getByText(LONG).props.numberOfLines).toBeUndefined();
  });
});

describe("F2 Bookings row", () => {
  it("shows the club name with no line limit, past and upcoming", async () => {
    const r = { kind: "booking" as const, id: "b1", start_at: "2026-11-19T08:00:00Z", end_at: "2026-11-19T09:30:00Z", club_name: LONG, club_slug: "b", timezone: "Asia/Beirut", title: "Padel 1", status: "cancelled", role: null };
    await render(<><Row r={r} /><Row r={r} past /></>);
    for (const t of screen.getAllByText(LONG)) expect(t.props.numberOfLines).toBeUndefined();
  });
});

describe("F3 club screen title", () => {
  it("Android: wraps to two lines, capped so two lines fit the 56 dp bar", async () => {
    await render(<WrappingHeaderTitle>{LONG}</WrappingHeaderTitle>);
    const t = screen.getByText(LONG);
    expect(t.props.numberOfLines).toBe(2);
    expect(t.props.maxFontSizeMultiplier).toBe(HEADER_MAX_FONT_SCALE);
    expect(2 * 21 * HEADER_MAX_FONT_SCALE).toBeLessThanOrEqual(52); // two lines inside the bar
    expect(t.props.accessibilityRole).toBe("header");
  });

  it("is used on Android only; iOS keeps the standard title", () => {
    const os = Platform.OS;
    try {
      (Platform as { OS: string }).OS = "android";
      expect(wrappingTitle(LONG)).toEqual({ title: LONG, headerTitle: expect.any(Function) });
      (Platform as { OS: string }).OS = "ios";
      expect(wrappingTitle(LONG)).toEqual({ title: LONG });
    } finally { (Platform as { OS: string }).OS = os; }
  });
});

describe("F4 selected time tile", () => {
  it("keeps the word up to the scale where it still fits, drops it above", () => {
    expect(tileLabel("selected", "$30", 2, 1)).toBe("$30 · selected");
    expect(tileLabel("selected", "$30", 2, SELECTED_WORD_MAX_SCALE)).toBe("$30 · selected");
    expect(tileLabel("selected", "$30", 2, 1.6)).toBe("$30");
    expect(tileLabel("selected", null, 2, 2)).toBe("");
    // other states unchanged at any size
    for (const fs of [1, 1.6, 2]) {
      expect(tileLabel("free", "$30", 3, fs)).toBe("$30 · 3 courts");
      expect(tileLabel("limited", "$30", 1, fs)).toBe("$30 · 1 court free");
      expect(tileLabel("booked", "$30", 0, fs)).toBe("Not free");
    }
  });

  it("at the largest text: no 'selected' word on the tile, still filled with the tick, still announced as selected", async () => {
    dims.fontScale = 1.6;
    await render(<TimeTile time="08:00" price="$30" freeCourts={5} selected onPress={() => {}} />);
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(screen.getByText("$30")).toBeTruthy();
    const b = screen.getByRole("button", { name: "08:00, $30, 5 courts free, selected" });
    expect(b.props.accessibilityState).toMatchObject({ selected: true });
  });

  it("at normal text: unchanged", async () => {
    await render(<TimeTile time="08:00" price="$30" freeCourts={5} selected onPress={() => {}} />);
    expect(screen.getByText("$30 · selected")).toBeTruthy();
  });
});

describe("F1 Courts card at the largest text", () => {
  const club = { id: "c1", name: LONG, slug: "b", town: "Batroun", priceFrom: 20, timezone: "Asia/Beirut", slotMinutes: 30, minMinutes: 60, maxMinutes: 120, cancelCutoffHours: 6, isDemo: false, courtCount: 5, sports: ["padel"], starts: [] };
  const direction = async () => {
    const { StyleSheet } = jest.requireActual("react-native");
    return StyleSheet.flatten(screen.getByTestId("club-name-row").props.style).flexDirection;
  };
  it("price beside the name up to 1.3x", async () => {
    dims.fontScale = PRICE_BESIDE_NAME_MAX_SCALE;
    await render(<ClubCard club={club} date="2026-11-19" sport={null} cover={null} />);
    expect(await direction()).toBe("row");
  });
  it("price under the name above it, so the name gets the full width", async () => {
    dims.fontScale = 1.6;
    await render(<ClubCard club={club} date="2026-11-19" sport={null} cover={null} />);
    expect(await direction()).toBeUndefined(); // column
    expect(screen.getByText(LONG)).toBeTruthy();
    expect(screen.getByText(/from/)).toBeTruthy();
  });
});

describe("F5 booking panel wording never breaks inside a unit", () => {
  // Imported here so the module list above stays as it was.
  const { unit, timeRange, joinParts } = jest.requireActual("../lib/panelText") as typeof import("../lib/panelText");
  const breakable = (s: string) => /[ \t\n]/.test(s) || /[–-](?!⁠)/.test(s.replace(/⁠[–-]⁠/g, ""));

  it("time range: no break point inside, reads the same", () => {
    const r = timeRange("08:00", "09:30");
    expect(breakable(r)).toBe(false);
    expect(r.replace(/⁠/g, "")).toBe("08:00–09:30");
  });

  it("date and duration are single units", () => {
    expect(unit("Thu 19 Nov")).toBe("Thu 19 Nov");
    expect(unit("1 h 30")).not.toMatch(/ /);
  });

  it("details: a line can break only after a dot", () => {
    const s = joinParts(["Padel", "Padel 1", "1 h 30"]);
    expect(s).toBe("Padel · Padel 1 · 1 h 30");
    expect(s.split(" ").length - 1).toBe(2); // the only ordinary spaces follow a dot
    expect(s.replace(/ /g, " ")).toBe("Padel · Padel 1 · 1 h 30");
  });
});
