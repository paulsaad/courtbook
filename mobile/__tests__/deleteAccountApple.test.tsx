/**
 * E1 (draft, off by default): the Delete account card with the Apple switch ON. The email-code fallback is actually
 * offered when Apple cannot be used (fourth review, point 1), and the switch OFF changes nothing (accountClosing.test).
 */
jest.mock("../lib/supabase", () => ({
  supabase: { rpc: jest.fn(), auth: { signOut: jest.fn(), getUser: jest.fn(), signInWithOtp: jest.fn(), verifyOtp: jest.fn() } },
}));
const deps = { current: null as unknown };
jest.mock("../lib/appleDeletionNative", () => ({ nativeAppleDeletionDeps: () => deps.current }));

import { Alert, Platform } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import { DeleteAccount } from "../components/DeleteAccount";
import { CLOSED_TEXT, CLOSED_TITLE, REAUTH_TEXT } from "../lib/accountClosing";
import { REVOCATION_NOTE, type AppleDeletionDeps } from "../lib/appleDeletion";

const A = { userId: "aaaaaaaa-0000-4000-8000-00000000000a", accessToken: "token-A-main" };
function appleDeps(deleteAnswer: { status: number; body: unknown }) {
  const posts: { path: string; token: string; body?: Record<string, string> }[] = [];
  let calls = 0;
  const d: AppleDeletionDeps = {
    mainSession: async () => A,
    post: async (path, token, body) => {
      posts.push({ path, token, body });
      if (path === "/api/account/apple-delete/intent") return { status: 200, body: { intent: "intent-for-A" } };
      calls++;
      return calls === 1 ? deleteAnswer : { status: 200, body: { closed: true, revocation: "skipped" } };
    },
    nonce: async () => ({ raw: "r", hashed: "h" }),
    appleSheet: async () => ({ identityToken: "idt", authorizationCode: "code" }),
    freshSignIn: async () => ({ ...A, accessToken: "token-A-fresh", signOut: async () => {} }),
    closedNow: async () => null,
    signOutEverywhere: async () => {},
  };
  return { d, posts };
}

describe("Delete account card, Apple switch on", () => {
  const rpc = supabase.rpc as jest.Mock;
  let alert: jest.SpyInstance;
  beforeEach(() => {
    expect(Platform.OS).toBe("ios");   // the jest-expo preset renders as iOS
    process.env.EXPO_PUBLIC_APPLE_DELETION = "1";
    rpc.mockReset();
    rpc.mockImplementation(async () => ({ data: null, error: null }));
    (supabase.auth.getUser as jest.Mock).mockResolvedValue({ data: { user: { id: A.userId, email: "a@example.com", identities: [{ provider: "apple" }] } } });
    (supabase.auth.signInWithOtp as jest.Mock).mockResolvedValue({ error: null });
    (supabase.auth.verifyOtp as jest.Mock).mockResolvedValue({ error: null });
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  });
  afterEach(() => { alert.mockRestore(); delete process.env.EXPO_PUBLIC_APPLE_DELETION; });

  it("Apple's token exchange or keys out of service: the card offers the email code, then deletes with the fallback", async () => {
    const { d, posts } = appleDeps({ status: 503, body: { closed: false, error: "apple_unavailable" } });
    deps.current = d;
    await render(<DeleteAccount />);
    await waitFor(() => expect(supabase.auth.getUser).toHaveBeenCalled());   // the switch check
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    void alert.mock.calls[0][2][1].onPress();
    // the email code is offered: sent to the account's own address, and the code field is shown
    expect(await screen.findByText(new RegExp(REAUTH_TEXT))).toBeTruthy();
    expect(supabase.auth.signInWithOtp).toHaveBeenCalledWith({ email: "a@example.com", options: { shouldCreateUser: false } });
    fireEvent.changeText(screen.getByTestId("delete-account-code"), "123456");
    // pressed again until the card has finished its previous step (the button is busy until then)
    await waitFor(() => { fireEvent.press(screen.getByTestId("delete-account-code-confirm")); expect(supabase.auth.verifyOtp).toHaveBeenCalled(); });
    await waitFor(() => expect(posts).toHaveLength(3));
    await waitFor(() => expect(alert).toHaveBeenLastCalledWith(CLOSED_TITLE, `${CLOSED_TEXT}\n\n${REVOCATION_NOTE}`));
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({ email: "a@example.com", token: "123456", type: "email" });
    // the fallback call: the app's OWN session (fresh from the email code), the same intent, never close_my_account directly
    expect(posts.at(-1)).toEqual({ path: "/api/account/apple-delete", token: "token-A-main", body: { method: "fallback", intent: "intent-for-A" } });
    expect(rpc).not.toHaveBeenCalledWith("close_my_account", expect.anything());
  });
  it("Apple refusing the code: also offers the email code", async () => {
    deps.current = appleDeps({ status: 422, body: { closed: false, error: "apple_code_rejected" } }).d;
    await render(<DeleteAccount />);
    await waitFor(() => expect(supabase.auth.getUser).toHaveBeenCalled());
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    void alert.mock.calls[0][2][1].onPress();
    expect(await screen.findByTestId("delete-account-code")).toBeTruthy();
  });
  it("a closure with revocation done: the plain closed message", async () => {
    deps.current = appleDeps({ status: 200, body: { closed: true, revocation: "done" } }).d;
    await render(<DeleteAccount />);
    await waitFor(() => expect(supabase.auth.getUser).toHaveBeenCalled());
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    void alert.mock.calls[0][2][1].onPress();
    await waitFor(() => expect(alert).toHaveBeenLastCalledWith(CLOSED_TITLE, CLOSED_TEXT));
  });
});
