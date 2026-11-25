/**
 * After signing in with nothing underneath (the app opened straight onto sign-in, e.g. from a link), the app goes to
 * `returnTo`. A link could set it to "//evil.example": it passed the old startsWith("/") check, and expo-router opens
 * such a value outside the app. Only a screen of this app is accepted now.
 */
const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("../lib/supabase", () => ({ supabase: { auth: { signInWithOtp: async () => ({ error: null }), verifyOtp: async () => ({ error: null }) } } }));
jest.mock("expo-router", () => ({ router: { canGoBack: () => false, back: jest.fn(), replace: (...a: unknown[]) => mockReplace(...a) }, useLocalSearchParams: () => mockParams }));
jest.mock("expo-apple-authentication", () => ({}));
jest.mock("expo-linking", () => ({}));
jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock("../lib/authRedirect", () => ({ AUTH_REDIRECT_URL: "courtbook://auth-callback" }));
jest.mock("../lib/appleAuth", () => ({ appleAvailable: async () => false, signInWithApple: jest.fn() }));
jest.mock("../lib/appIdentity", () => ({ installedVariant: "production" }));

import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import SignIn from "../app/sign-in";

const { shouldLinkExternally } = jest.requireActual("expo-router/build/utils/url") as { shouldLinkExternally: (h: string) => boolean };

async function signInWith(returnTo: string): Promise<string> {
  mockParams = { returnTo };
  mockReplace.mockClear();
  await render(<SignIn />);
  await fireEvent.changeText(screen.getByTestId("email"), "player@example.com");
  await fireEvent.press(screen.getByText("Email me a code"));
  await waitFor(() => expect(screen.getByTestId("code")).toBeTruthy());
  await fireEvent.changeText(screen.getByTestId("code"), "12345678");
  await fireEvent.press(screen.getByTestId("verify"));
  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  return String(mockReplace.mock.calls.at(-1)?.[0]);
}

describe("sign-in: where the app goes afterwards", () => {
  it("to the screen it came from", async () => {
    expect(await signInWith("/club/batroun")).toBe("/club/batroun");
  });
  for (const attack of ["//evil.example", "https://evil.example", "mailto:a@evil.example", "/\\evil.example"]) {
    it(`never outside the app: returnTo=${JSON.stringify(attack)} → "/"`, async () => {
      const target = await signInWith(attack);
      expect(target).toBe("/");
      expect(shouldLinkExternally(target)).toBe(false);
    });
  }
});
