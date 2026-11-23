/**
 * Galaxy A17 acceptance (23 Nov): in Help & Feedback, the text field of "Report an app problem" and "Suggest an
 * improvement" sat behind the Samsung keyboard. The app draws edge to edge, so Android does not resize the window;
 * the sheet must lift itself above the keyboard, shrink to the space left, and scroll to the text field.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() }, Stack: { Screen: () => null } }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
jest.mock("../lib/gameActions", () => ({ ...jest.requireActual("../lib/gameActions"), GAME_WRITES_AVAILABLE: true }));
jest.mock("../lib/buildInfo", () => ({ currentBuild: () => [{ label: "Version", value: "0.3.0 (build 12)" }] }));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import { Keyboard, Platform, StyleSheet } from "react-native";
import { supabase } from "../lib/supabase";
import { space } from "../lib/theme";
import Help from "../app/help";
import { useRevealOnKeyboard } from "../components/KeyboardAware";

declare const require: (m: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
const { readFileSync } = require("fs") as { readFileSync: (p: string, e: string) => string };
const { join } = require("path") as { join: (...p: string[]) => string };

// A phone with a status bar and a 3-button navigation bar (the A17's default).
const metrics = { frame: { x: 0, y: 0, width: 412, height: 915 }, insets: { top: 32, left: 0, right: 0, bottom: 48 } };
const handlers: Record<string, ((e?: unknown) => void)[]> = {};
const emit = (event: string, e?: unknown) => (handlers[event] ?? []).forEach((fn) => fn(e));
// A 315 dp keyboard on a 915 dp screen: its top edge is at 600.
const KEYBOARD = { endCoordinates: { screenX: 0, screenY: 600, width: 412, height: 315 }, duration: 0, easing: "keyboard" };


beforeEach(() => {
  jest.replaceProperty(Platform, "OS", "android");
  for (const k of Object.keys(handlers)) delete handlers[k];
  jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, fn: (e?: unknown) => void) => {
    (handlers[event] ??= []).push(fn);
    return { remove: jest.fn() };
  }) as never);
  (supabase.rpc as jest.Mock).mockImplementation(async (fn: string) => (fn === "my_account_status" ? { data: "active", error: null } : { data: null, error: null }));
});
afterEach(() => jest.restoreAllMocks());

async function openForm(testID: "help-problem" | "help-suggest") {
  const q = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  await render(<SafeAreaProvider initialMetrics={metrics}><QueryClientProvider client={q}><Help /></QueryClientProvider></SafeAreaProvider>);
  await fireEvent.press(await screen.findByTestId(testID));
  return screen.getByTestId("feedback-text");
}
const bottomPadding = () => StyleSheet.flatten(screen.getByTestId("sheet").props.style).paddingBottom;

describe.each([["Report an app problem", "help-problem"], ["Suggest an improvement", "help-suggest"]] as const)("%s with the keyboard open", (_name, testID) => {
  it("the sheet is drawn edge to edge and lifted above the keyboard by exactly the overlap (Android does not resize)", async () => {
    await openForm(testID);
    const modal = screen.getByTestId("sheet-modal");
    expect(modal.props.statusBarTranslucent).toBe(true);
    expect(modal.props.navigationBarTranslucent).toBe(true);
    const frame = screen.getByTestId("sheet-keyboard-frame");
    // the status bar is kept clear by padding, since the sheet now draws under it
    expect(StyleSheet.flatten(frame.props.style).paddingTop).toBe(metrics.insets.top + space.lg);
    // the frame fills the whole screen; the keyboard covers 315 dp of it, so 315 dp of padding lift the sheet
    await fireEvent(frame, "layout", { persist: () => {}, nativeEvent: { layout: { x: 0, y: 0, width: 412, height: 915 } } });
    expect(StyleSheet.flatten(screen.getByTestId("sheet-keyboard-frame").props.style).paddingBottom ?? 0).toBe(0);
    await act(async () => { emit("keyboardDidShow", KEYBOARD); });
    expect(StyleSheet.flatten(screen.getByTestId("sheet-keyboard-frame").props.style).paddingBottom).toBe(315);
    await act(async () => { emit("keyboardDidHide", null); });
    expect(StyleSheet.flatten(screen.getByTestId("sheet-keyboard-frame").props.style).paddingBottom).toBe(0);
  });

  it("the sheet can shrink to the space above the keyboard, and the text field is inside its scrolling area", async () => {
    const field = await openForm(testID);
    expect(StyleSheet.flatten(screen.getByTestId("sheet").props.style).flexShrink).toBe(1);
    const scroll = screen.getByTestId("sheet-scroll");
    let node: typeof field | null = field;
    while (node && node !== scroll) node = node.parent as typeof field | null;
    expect(node).toBe(scroll);                                   // the field scrolls with the form, it is not pinned
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled"); // Send works with the keyboard up
  });

  it("when the keyboard opens the navigation-bar inset is dropped; typing works; it comes back when the keyboard closes", async () => {
    jest.useFakeTimers();
    try {
      const field = await openForm(testID);
      expect(bottomPadding()).toBe(metrics.insets.bottom + space.md);
      await fireEvent(field, "focus");
      await act(async () => { emit("keyboardDidShow", KEYBOARD); jest.advanceTimersByTime(100); });
      expect(bottomPadding()).toBe(space.md);
      await fireEvent.changeText(field, "Typed with the keyboard open");
      expect(screen.getByDisplayValue("Typed with the keyboard open")).toBeTruthy();
      await act(async () => { emit("keyboardDidHide", null); });
      expect(bottomPadding()).toBe(metrics.insets.bottom + space.md);
    } finally {
      jest.useRealTimers();
    }
  });
});

it("Android listens to the keyboard's 'did' events (it has no 'will' events)", async () => {
  await openForm("help-problem");
  expect(Object.keys(handlers)).toEqual(expect.arrayContaining(["keyboardDidShow", "keyboardDidHide"]));
});

it("the sheet's scroll area scrolls to its end (text field and Send) each time the keyboard opens, not before", async () => {
  jest.useFakeTimers();
  try {
    const scrollToEnd = jest.fn();
    const { result, rerender } = await renderHook(({ k }: { k: boolean }) => useRevealOnKeyboard(k), { initialProps: { k: false } });
    result.current.current = { scrollToEnd } as never;
    jest.advanceTimersByTime(100);
    expect(scrollToEnd).not.toHaveBeenCalled();
    await rerender({ k: true });
    await act(async () => { jest.advanceTimersByTime(100); });
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: true });
  } finally {
    jest.useRealTimers();
  }
});

it("the report and feedback sheet uses that scroll ref (source check: the reveal is wired to the form's ScrollView)", () => {
  const src = readFileSync(join(__dirname, "../components/game/SafetySheets.tsx"), "utf8");
  expect(src).toMatch(/const scroll = useRevealOnKeyboard\(keyboard\);/);
  expect(src).toMatch(/<ScrollView ref=\{scroll\}[^>]*testID="sheet-scroll"/);
});
