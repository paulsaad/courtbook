/**
 * A17 pilot test, 28 Nov: the corrections that are not a whole screen (F1 sheets above the keyboard, F2 Directions,
 * F3 Home's Your clubs after a re-add, F5 message times in the phone's zone, F7 the red CANCELLED status).
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
import { render, screen, within } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient } from "@tanstack/react-query";
import { FeedbackSheet, ReportSheet } from "../components/game/SafetySheets";
import { mapsUrl } from "../lib/clubInfo";
import { createFavouriteSync, favouriteKeys } from "../lib/favourites";
import { chatRows, deviceTimeZone } from "../lib/chat";
import { hhmm } from "@shared/time";
import { TicketRow } from "../components/Ticket";
import { color } from "../lib/theme";

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 34 } };

describe("F1: report and feedback sheets rise above the keyboard", () => {
  it.each([
    ["feedback", <FeedbackSheet key="f" kind="app_problem" onSend={async () => null} onClose={() => {}} />, "Report an app problem", "feedback-send"],
    ["report", <ReportSheet key="r" visible what="message" onSend={async () => null} onClose={() => {}} />, "Note for the report", "report-send"],
  ])("%s: the sheet is inside a keyboard-avoiding view that pads (Android does not resize a modal)", async (_n, ui, field, send) => {
    await render(<SafeAreaProvider initialMetrics={metrics}>{ui}</SafeAreaProvider>);
    // the keyboard-avoiding wrapper (behavior "padding", see SafetySheets) holds the whole sheet: the text field and Send
    const lift = within(screen.getByTestId("sheet-keyboard"));
    expect(lift.getByLabelText(field)).toBeTruthy();
    expect(lift.getByTestId(send)).toBeTruthy();
  });
});

describe("F2: Directions only to one place", () => {
  it("the demo club's place-name link gives no Directions; a point (own or in the link) routes there", () => {
    expect(mapsUrl({ lat: null, lng: null, location_url: "https://maps.google.com/?q=Batroun" })).toBeNull();
    expect(mapsUrl({ lat: 34.2553, lng: 35.6586, location_url: "https://maps.google.com/?q=Batroun" })).toBe("https://www.google.com/maps/dir/?api=1&destination=34.2553,35.6586");
    expect(mapsUrl({ lat: null, lng: null, location_url: "https://www.google.com/maps/place/X/@34.2553,35.6586,17z" })).toBe("https://www.google.com/maps/dir/?api=1&destination=34.2553,35.6586");
    expect(mapsUrl({ lat: null, lng: null, location_url: "https://maps.app.goo.gl/abc" })).toBe("https://maps.app.goo.gl/abc");
  });
});

describe("F3: Home's Your clubs is re-read once a heart's save has settled", () => {
  it("after the last pending save: both the ids and the Your clubs rows are invalidated", async () => {
    const qc = new QueryClient();
    qc.setQueryData(favouriteKeys.mine("me"), []);
    const spy = jest.spyOn(qc, "invalidateQueries");
    const sync = createFavouriteSync({ qc, userId: "me", currentUserId: () => "me", available: true, save: async () => true });
    const r = await sync.toggle("batroun", true);
    expect(r.ok).toBe(true);
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(["favourites", "me"]));
    expect(keys).toContain(JSON.stringify(["favourite-clubs", "me"]));
  });
});

describe("F5: a message's time is the phone's own time", () => {
  const real = Intl.DateTimeFormat;
  afterEach(() => { (Intl as { DateTimeFormat: unknown }).DateTimeFormat = real; });
  it("a phone in Sweden sees 12:49 for a message sent at 11:49 UTC (the club's Beirut time would say 13:49)", () => {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = Object.assign(
      (...a: unknown[]) => (a.length ? new (real as never as new (...b: unknown[]) => Intl.DateTimeFormat)(...a) : { resolvedOptions: () => ({ timeZone: "Europe/Stockholm" }) }),
      real,
    );
    const tz = deviceTimeZone("Asia/Beirut");
    expect(tz).toBe("Europe/Stockholm");
    expect(hhmm("2026-11-28T11:49:00Z", tz)).toBe("12:49");
    expect(hhmm("2026-11-28T11:49:00Z", "Asia/Beirut")).toBe("13:49");
    // day separators follow the same zone: 23:30 UTC is still "today" in Stockholm on the 28th
    const rows = chatRows([{ id: "m", profile_id: "x", name: null, body: "hi", created_at: "2026-11-28T22:30:00Z", deleted: false }], tz, new Date("2026-11-28T22:40:00Z"));
    expect(rows[0]).toMatchObject({ kind: "day", label: "Today" });
  });
  it("falls back to the club's zone when the phone does not say", () => {
    (Intl as { DateTimeFormat: unknown }).DateTimeFormat = Object.assign(() => { throw new Error("no Intl"); }, real);
    expect(deviceTimeZone("Asia/Beirut")).toBe("Asia/Beirut");
  });
});

describe("F7: a cancelled booking's status is the approved red badge", () => {
  it("CANCELLED in danger red on its soft fill; other rows unchanged", async () => {
    await render(<TicketRow label="Status" value="Cancelled" tone="danger" last />);
    const badge = screen.getByTestId("status-badge");
    expect(screen.getByText("CANCELLED")).toBeTruthy();
    const flat = (s: unknown) => Object.assign({}, ...[s].flat(Infinity as 1) as object[]);
    expect(flat(badge.props.style).backgroundColor).toBe(color.dangerSoft);
    expect(flat(screen.getByText("CANCELLED").props.style).color).toBe(color.danger);
    await render(<TicketRow label="Cancellation" value="Free until Sat 02:00" last />);
    expect(screen.queryByTestId("status-badge")).toBeNull();
  });
});
