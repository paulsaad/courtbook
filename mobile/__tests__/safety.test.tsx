/**
 * Report, block, community rules (M3-S): the app calls the draft's functions with its argument names,
 * the report sheet says what the spec says (no response-time promise; the emergency line for danger;
 * the block offer), and nothing is drawn while M3-S is not applied.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));

// Node's fs in the test runner, without adding Node types to the app's TypeScript project
declare const require: (m: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
const fs = require("fs") as { readFileSync: (p: string, enc: string) => string };
const path = require("path") as { join: (...p: string[]) => string };
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  blockPlayer, COMMUNITY_RULES, REPORT_DANGER, REPORT_REASONS, REPORT_THANKS, reportContent, SAFETY_RPC_ARGS, fetchSafety, feedbackContext, sendFeedback, isMissingFunction,
} from "../lib/safety";
import { ReportSheet } from "../components/game/SafetySheets";
import { detailSections, SCREEN_FEATURES } from "../lib/gameScreens";

const DRAFT = fs.readFileSync(path.join(__dirname, "../../supabase/migrations/0074_safety.sql"), "utf8");
const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

describe("contract with the M3-S draft", () => {
  it.each(Object.entries(SAFETY_RPC_ARGS))("%s takes %p", (fn, args) => {
    const m = new RegExp(`create or replace function ${fn}\\(([^)]*)\\)`).exec(DRAFT);
    expect(m).not.toBeNull();
    const names = m![1].split(",").map((a) => a.trim().split(/\s+/)[0]).filter(Boolean);
    expect(names).toEqual([...args]);
  });
  it("the reasons are the ones the draft accepts, in the spec's order", () => {
    expect(REPORT_REASONS.map((r) => r.key)).toEqual(["spam", "abuse", "inappropriate", "danger", "other"]);
    expect(DRAFT).toContain("p_reason not in ('spam', 'abuse', 'inappropriate', 'danger', 'other')");
  });
  it("calls send the draft's argument names; an empty note is sent as null", async () => {
    const rpc = jest.fn(async () => ({ data: null, error: null }));
    await reportContent("message", "m-1", "abuse", "   ", rpc);
    expect(rpc).toHaveBeenCalledWith("report_content", { p_kind: "message", p_target: "m-1", p_reason: "abuse", p_note: null });
    await blockPlayer("p-1", rpc);
    expect(rpc).toHaveBeenCalledWith("block_player", { p_profile: "p-1" });
  });
  it("refusals read as sentences", async () => {
    const f = await blockPlayer("me", async () => ({ data: null, error: { code: "P0001", message: "bad_target" } }));
    expect(f?.message).toBe("You can't report or block yourself.");
  });
});

describe("on only where the database has 0074 (decided at run time)", () => {
  it("the base switch is off; the game screen adds report from useSafety", () => {
    expect(SCREEN_FEATURES.report).toBe(false);
    expect(detailSections).toBeDefined();
  });
  it("before 0074 (function missing): off, and nothing thrown", async () => {
    const rpc = jest.fn(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function public.my_account_status without parameters in the schema cache" } }));
    await expect(fetchSafety(rpc)).resolves.toEqual({ available: false, suspended: false });
    expect(rpc).toHaveBeenCalledWith("my_account_status", {});
  });
  it("with 0074: on; a suspended account is known", async () => {
    await expect(fetchSafety(async () => ({ data: "active", error: null }))).resolves.toEqual({ available: true, suspended: false });
    await expect(fetchSafety(async () => ({ data: "suspended", error: null }))).resolves.toEqual({ available: true, suspended: true });
  });
  it("offline or a server error: asked again later (thrown), never read as 'missing'", async () => {
    await expect(fetchSafety(async () => ({ data: null, error: { message: "Network request failed" } }))).rejects.toBeTruthy();
    expect(isMissingFunction({ message: "Network request failed" })).toBe(false);
  });
});

describe("community rules (approved wording, revised 20 Nov)", () => {
  it("exactly the five approved rules, and no terms-of-use sentence on the sheet", async () => {
    expect(COMMUNITY_RULES).toEqual([
      "Keep it about sports. CourtBook is for finding players, booking courts and organising games.",
      "Respect others. Harassment, threats, insults and hate speech are not allowed.",
      "Respect personal boundaries. Don't make unwanted romantic or sexual advances toward other players.",
      "No advertising or solicitation. Do not use CourtBook to sell products, promote services, recruit people or ask for money.",
      "Respect privacy. Only use another player's contact information to arrange a game. If someone breaks these rules, report it. CourtBook may remove messages or suspend accounts.",
    ]);
    const sheets = fs.readFileSync(path.join(__dirname, "../components/game/SafetySheets.tsx"), "utf8");
    expect(sheets).not.toMatch(/terms of use/i);
  });
});

describe("Help & Feedback", () => {
  it("sends kind, trimmed text and the app context; empty text is not sent", async () => {
    const rpc = jest.fn(async () => ({ data: null, error: null }));
    expect(await sendFeedback("app_problem", "  map is blank  ", "android · 0.3.0", rpc)).toBeNull();
    expect(rpc).toHaveBeenCalledWith("send_feedback", { p_kind: "app_problem", p_text: "map is blank", p_context: "android · 0.3.0" });
    expect((await sendFeedback("suggestion", "   ", "x", rpc))?.reason).toBe("text_required");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("a refusal reads as a sentence", async () => {
    const f = await sendFeedback("suggestion", "x", "c", async () => ({ data: null, error: { message: "slow_down", code: "P0001" } }));
    expect(f?.message).toMatch(/Wait a moment/);
  });
  it("context: platform, version and update, nothing personal", () => {
    expect(feedbackContext("android", [{ label: "Version", value: "0.3.0 (build 12)" }, { label: "Update", value: "01a1f89e-f412-753b" }]))
      .toBe("android · 0.3.0 (build 12) · update 01a1f89e");
    expect(feedbackContext("ios", [{ label: "Version", value: "0.3.0 (build 3)" }, { label: "Code", value: "Built-in" }])).toBe("ios · 0.3.0 (build 3) · built-in code");
  });
});

describe("report sheet", () => {
  it("send is off until a reason is chosen; after sending: thanks, no time promise, block offer", async () => {
    const onSend = jest.fn(async () => null);
    const onBlock = jest.fn();
    await render(<SafeAreaProvider initialMetrics={metrics}><ReportSheet visible what="message" onSend={onSend} onBlock={onBlock} onClose={() => {}} /></SafeAreaProvider>);
    expect(screen.getByTestId("report-send").props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByText("Abuse or harassment"));
    await fireEvent.press(screen.getByTestId("report-send"));
    expect(onSend).toHaveBeenCalledWith("abuse", "");
    expect(await screen.findByText(`${REPORT_THANKS} You can also block this player now.`)).toBeTruthy();
    expect(screen.queryByText(REPORT_DANGER)).toBeNull();
    expect(screen.queryByText(/hours|days|soon/i)).toBeNull();
    await fireEvent.press(screen.getByText("Block this player"));
    expect(onBlock).toHaveBeenCalled();
  });
  it("Threat or danger adds the emergency line", async () => {
    await render(<SafeAreaProvider initialMetrics={metrics}><ReportSheet visible what="game" onSend={async () => null} onClose={() => {}} /></SafeAreaProvider>);
    await fireEvent.press(screen.getByText("Threat or danger"));
    await fireEvent.press(screen.getByTestId("report-send"));
    expect(await screen.findByText(REPORT_DANGER)).toBeTruthy();
    expect(screen.queryByText("Block this player")).toBeNull(); // a game report offers no block
  });
  it("a refusal is shown and the sheet stays", async () => {
    await render(<SafeAreaProvider initialMetrics={metrics}><ReportSheet visible what="message" onSend={async () => "This game isn't open any more, or isn't available to you."} onClose={() => {}} /></SafeAreaProvider>);
    await fireEvent.press(screen.getByText("Spam"));
    await fireEvent.press(screen.getByTestId("report-send"));
    expect(await screen.findByText("This game isn't open any more, or isn't available to you.")).toBeTruthy();
    expect(screen.queryByText("Report sent")).toBeNull();
  });
});

describe("blocked player in a shared game (approved model: the game stays; the blocker is told)", () => {
  const { blockedNotice } = jest.requireActual("../lib/safety") as typeof import("../lib/safety");
  const people = [
    { profile_id: "org", name: "Omar", is_organizer: true },
    { profile_id: "me", name: "Me", is_organizer: false },
    { profile_id: "sami", name: "Sami", is_organizer: false },
  ];
  const b = (id: string) => ({ profile_id: id, name: null, created_at: "2026-11-20T10:00:00Z" });
  it("nothing when no one I blocked is here", () => {
    expect(blockedNotice(people, [b("zzz")], "me", false)).toBeNull();
    expect(blockedNotice(people, [], "me", false)).toBeNull();
    expect(blockedNotice(null, [b("sami")], "me", false)).toBeNull();
  });
  it("a player: named, messages hidden, I can leave", () => {
    expect(blockedNotice(people, [b("sami")], "me", false)).toBe("You blocked Sami, who is in this game. You won't see their messages. You can leave the game if you'd rather not play.");
  });
  it("the organiser: I can leave", () => {
    expect(blockedNotice(people, [b("org")], "me", false)).toMatch(/^You blocked the organiser of this game\..*leave the game/);
  });
  it("as organiser: I can remove them", () => {
    expect(blockedNotice(people, [b("sami")], "org", true)).toMatch(/You can remove them\.$/);
  });
  it("never about myself", () => {
    expect(blockedNotice(people, [b("me")], "me", false)).toBeNull();
  });
});

describe("contract: new safety reads", () => {
  it("my_blocked_players and my_account_status take no arguments", () => {
    expect(DRAFT).toMatch(/create or replace function my_blocked_players\(\)/);
    expect(DRAFT).toMatch(/create or replace function my_account_status\(\) returns text/);
    expect(DRAFT).toContain("then 'suspended' else 'active' end");
  });
});
