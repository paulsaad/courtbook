/**
 * Regression: 0.3.0 on the live database could not sign in by email — live sends 8-digit codes and
 * the code field stopped at 6. The app now takes any length Supabase can be set to (6–10 digits), as
 * the website does, and sends the whole code.
 */
const mockSignInWithOtp = jest.fn(async () => ({ error: null }));
const mockVerifyOtp = jest.fn(async () => ({ error: null }));
jest.mock("../lib/supabase", () => ({ supabase: { auth: { signInWithOtp: (...a: unknown[]) => mockSignInWithOtp(...(a as [])), verifyOtp: (...a: unknown[]) => mockVerifyOtp(...(a as [])) } } }));
jest.mock("expo-router", () => ({ router: { canGoBack: () => true, back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({}) }));
jest.mock("expo-apple-authentication", () => ({}));
jest.mock("expo-linking", () => ({}));
jest.mock("expo-web-browser", () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock("../lib/authRedirect", () => ({ AUTH_REDIRECT_URL: "courtbook://auth-callback" }));
jest.mock("../lib/appleAuth", () => ({ appleAvailable: async () => false, signInWithApple: jest.fn() }));
jest.mock("../lib/appIdentity", () => ({ installedVariant: "production" }));

import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import SignIn from "../app/sign-in";
import { CODE_MAX, CODE_MIN, cleanCode, codeReady } from "../lib/otpCode";

describe("code rule (6–10 digits, as Supabase allows and the website accepts)", () => {
  it("accepts every length Supabase can be set to, and nothing else", () => {
    expect([CODE_MIN, CODE_MAX]).toEqual([6, 10]);
    for (let n = 6; n <= 10; n++) expect(codeReady("1".repeat(n))).toBe(true);
    expect(codeReady("12345")).toBe(false);
    expect(codeReady("12345678901")).toBe(false);
    expect(codeReady("1234567a")).toBe(false);
    expect(codeReady("")).toBe(false);
  });
  it("keeps digits only, up to 10 (pasted codes with spaces or a line break)", () => {
    expect(cleanCode("1234 5678")).toBe("12345678");
    expect(cleanCode(" 12345678\n")).toBe("12345678");
    expect(cleanCode("123456789012")).toBe("1234567890");
  });
  it("matches the website's sign-in rule", () => {
    // src/app/login/LoginForm.tsx: pattern="[0-9]{6,10}"
    expect(`[0-9]{${CODE_MIN},${CODE_MAX}}`).toBe("[0-9]{6,10}");
  });
});

async function toCodeStep() {
  await render(<SignIn />);
  await fireEvent.changeText(screen.getByTestId("email"), "player@example.com");
  await fireEvent.press(screen.getByText("Email me a code"));
  await waitFor(() => expect(screen.getByTestId("code")).toBeTruthy());
}

describe("sign-in screen, code step", () => {
  beforeEach(() => { mockSignInWithOtp.mockClear(); mockVerifyOtp.mockClear(); });

  it("an 8-digit live code can be typed in full and is sent whole", async () => {
    await toCodeStep();
    expect(screen.getByTestId("code").props.maxLength).toBe(10);
    await fireEvent.changeText(screen.getByTestId("code"), "87654321");
    expect(screen.getByTestId("code").props.value).toBe("87654321");
    expect(screen.getByTestId("verify").props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(screen.getByTestId("verify"));
    await waitFor(() => expect(mockVerifyOtp).toHaveBeenCalledWith({ email: "player@example.com", token: "87654321", type: "email" }));
  });

  it("a 6-digit staging code still works", async () => {
    await toCodeStep();
    await fireEvent.changeText(screen.getByTestId("code"), "123456");
    await fireEvent.press(screen.getByTestId("verify"));
    await waitFor(() => expect(mockVerifyOtp).toHaveBeenCalledWith(expect.objectContaining({ token: "123456" })));
  });

  it("Sign in stays off below 6 digits", async () => {
    await toCodeStep();
    await fireEvent.changeText(screen.getByTestId("code"), "12345");
    expect(screen.getByTestId("verify").props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByTestId("verify"));
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it("asks for the code only: no fixed length, no email link", async () => {
    await toCodeStep();
    expect(screen.getByText(/We sent a code to player@example\.com\. Type it here to sign in\./)).toBeTruthy();
    expect(screen.queryByText(/6-digit/)).toBeNull();
    expect(screen.queryByText(/link/i)).toBeNull();
  });
});
