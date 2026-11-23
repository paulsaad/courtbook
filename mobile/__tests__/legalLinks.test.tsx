/**
 * M5: the privacy policy, terms and account-deletion page are one tap away in the app — on the sign-in screen (before
 * an account exists) and in Profile → Help & Feedback (signed in or not) — and open the website's pages.
 */
const mockOpen = jest.fn(async (_url: string) => ({ type: "opened" }));
const mockOpenURL = jest.fn(async (_url: string): Promise<void> => undefined);
let mockSignedIn = true;
jest.mock("expo-web-browser", () => ({ openBrowserAsync: (u: string) => mockOpen(u), openAuthSessionAsync: jest.fn() }));
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(async () => ({ data: null, error: null })), from: jest.fn(), auth: { signInWithOtp: jest.fn(), verifyOtp: jest.fn(), onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn(), canGoBack: () => true, back: jest.fn(), replace: jest.fn() }, Stack: { Screen: () => null }, useLocalSearchParams: () => ({}) }));
jest.mock("../lib/session", () => ({ useSession: () => (mockSignedIn ? { status: "signed-in", session: { user: { id: "me" } } } : { status: "signed-out" }) }));
jest.mock("../lib/buildInfo", () => ({ currentBuild: () => [] }));
jest.mock("expo-apple-authentication", () => ({}));
jest.mock("expo-linking", () => ({}));
jest.mock("../lib/authRedirect", () => ({ AUTH_REDIRECT_URL: "courtbook://auth-callback" }));
jest.mock("../lib/appleAuth", () => ({ appleAvailable: async () => false, signInWithApple: jest.fn() }));
jest.mock("../lib/appIdentity", () => ({ installedVariant: "production" }));

declare const require: (m: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
const { existsSync } = require("fs") as { existsSync: (p: string) => boolean };
const { join } = require("path") as { join: (...p: string[]) => string };
import { Linking } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { LegalLinks } from "../components/LegalLinks";
import { LEGAL_PAGES, WEBSITE_URL, openLegalPage } from "../lib/legal";
import Help from "../app/help";
import SignIn from "../app/sign-in";

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const wrap = (el: React.ReactElement) =>
  <SafeAreaProvider initialMetrics={metrics}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider></SafeAreaProvider>;

beforeEach(() => { mockOpen.mockClear(); mockOpenURL.mockClear(); jest.spyOn(Linking, "openURL").mockImplementation(mockOpenURL); });

describe("legal links in the app (M5)", () => {
  it("every link points at a page that exists on the website, over https", () => {
    expect(WEBSITE_URL).toMatch(/^https:\/\/[^/]+$/);
    for (const p of LEGAL_PAGES) {
      const path = new URL(p.url).pathname;
      expect(existsSync(join(__dirname, "../../src/app", path, "page.tsx"))).toBe(true);
    }
  });

  it("each link is announced as a link with its name, and opens its page in the in-app browser", async () => {
    await render(<LegalLinks />);
    for (const p of LEGAL_PAGES) {
      const link = screen.getByRole("link", { name: p.label });
      expect(link).toBeTruthy();
      await fireEvent.press(link);
      expect(mockOpen).toHaveBeenLastCalledWith(p.url);
    }
    expect(mockOpen).toHaveBeenCalledTimes(LEGAL_PAGES.length);
  });

  it("if the in-app browser cannot open, the phone's browser opens the page instead", async () => {
    mockOpen.mockRejectedValueOnce(new Error("no browser"));
    await openLegalPage(LEGAL_PAGES[0].url);
    expect(mockOpenURL).toHaveBeenCalledWith(LEGAL_PAGES[0].url);
  });

  it("sign-in screen: privacy policy and terms before any account exists", async () => {
    await render(<SignIn />);
    expect(screen.getByRole("link", { name: "Privacy policy" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Terms of use" })).toBeTruthy();
  });

  it("Help & Feedback: all three, signed out as well as signed in", async () => {
    for (const signedIn of [false, true]) {
      mockSignedIn = signedIn;
      const r = await render(wrap(<Help />));
      expect(await screen.findByTestId("help-legal")).toBeTruthy();
      for (const p of LEGAL_PAGES) expect(screen.getByRole("link", { name: p.label })).toBeTruthy();
      r.unmount();
    }
    mockSignedIn = true;
  });
});
