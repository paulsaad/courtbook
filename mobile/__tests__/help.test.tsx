jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
jest.mock("../lib/gameActions", () => ({ ...jest.requireActual("../lib/gameActions"), GAME_WRITES_AVAILABLE: true }));
jest.mock("../lib/buildInfo", () => ({ currentBuild: () => [{ label: "Version", value: "0.3.0 (build 12)" }, { label: "Update", value: "01a1f89e-f412" }] }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import Help from "../app/help";

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
type Call = { fn: string; args: unknown };
let calls: Call[] = [];

async function show(has0074: boolean) {
  calls = [];
  (supabase.rpc as jest.Mock).mockImplementation(async (fn: string, args: unknown) => {
    calls.push({ fn, args });
    if (fn === "my_account_status") return has0074 ? { data: "active", error: null } : { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    if (fn === "my_recent_players") return { data: [{ profile_id: "p-sami", name: "Sami", last_game: "2026-11-21T16:00:00Z" }], error: null };
    return { data: null, error: null };
  });
  const q = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  await render(<SafeAreaProvider initialMetrics={metrics}><QueryClientProvider client={q}><Help /></QueryClientProvider></SafeAreaProvider>);
}

describe("Profile → Help & Feedback", () => {
  it("before 0074: the contact address only", async () => {
    await show(false);
    expect(await screen.findByText("courtbook.contact@gmail.com")).toBeTruthy();
    expect(screen.queryByText("Report an app problem")).toBeNull();
  });

  it("app problem: sent privately with the app version, then thanks", async () => {
    await show(true);
    await fireEvent.press(await screen.findByTestId("help-problem"));
    await fireEvent.changeText(screen.getByTestId("feedback-text"), "  The map stays blank  ");
    await fireEvent.press(screen.getByTestId("feedback-send"));
    expect(await screen.findByText("Thanks. Only the CourtBook team sees this.")).toBeTruthy();
    expect(calls.find((c) => c.fn === "send_feedback")?.args).toEqual({ p_kind: "app_problem", p_text: "The map stays blank", p_context: expect.stringMatching(/0\.3\.0 \(build 12\) · update 01a1f89e$/) });
  });

  it("suggestion uses the same private channel", async () => {
    await show(true);
    await fireEvent.press(await screen.findByTestId("help-suggest"));
    await fireEvent.changeText(screen.getByTestId("feedback-text"), "Show the weather");
    await fireEvent.press(screen.getByTestId("feedback-send"));
    await screen.findByText("Thanks. Only the CourtBook team sees this.");
    expect(calls.find((c) => c.fn === "send_feedback")?.args).toMatchObject({ p_kind: "suggestion", p_text: "Show the weather" });
  });

  it("player behaviour: pick from my games, then the usual report", async () => {
    await show(true);
    await fireEvent.press(await screen.findByTestId("help-report-player"));
    await fireEvent.press(await screen.findByTestId("recent-p-sami"));
    await fireEvent.press(await screen.findByTestId("reason-abuse"));
    await fireEvent.press(screen.getByTestId("report-send"));
    await screen.findByText(/Thanks for reporting this/);
    expect(calls.find((c) => c.fn === "report_content")?.args).toEqual({ p_kind: "player", p_target: "p-sami", p_reason: "abuse", p_note: null });
  });
});
