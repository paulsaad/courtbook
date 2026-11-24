/**
 * M2 (0086): one-step account closing in the app. The logic (lib/accountClosing.ts), the screen
 * (components/DeleteAccount.tsx), the wording kept identical to the website's, and the contract with the migration.
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), auth: { signOut: jest.fn() } } }));

declare const require: (m: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
const fs = require("fs") as { readFileSync: (p: string, enc: string) => string };
const path = require("path") as { join: (...p: string[]) => string };
import { Alert } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import {
  closeMyAccount, signOutIfClosed, CLOSE_FAILED, CLOSED_TEXT, CLOSED_TITLE, CONFIRM_TEXT, CONFIRM_TITLE,
  PROCESSING_PAUSED, REAUTH_TEXT, legacyRequestText, sendReauthCode, verifyAndClose,
} from "../lib/accountClosing";
import { DeleteAccount } from "../components/DeleteAccount";

const MIGRATION = fs.readFileSync(path.join(__dirname, "../../supabase/migrations/0086_account_deletion_one_confirmation.sql"), "utf8");
const WEB_COPY = fs.readFileSync(path.join(__dirname, "../../src/lib/deletion/copy.ts"), "utf8");
const ok = (data: unknown = null) => ({ data, error: null });
const err = (message: string) => ({ data: null, error: { message } });

describe("wording and contract", () => {
  it("the app's texts are the website's, word for word", () => {
    const flat = WEB_COPY.replace(/"\s*\+\s*"/g, "");
    for (const t of [CONFIRM_TITLE, CONFIRM_TEXT, CLOSED_TITLE, CLOSED_TEXT]) expect(flat).toContain(t);
  });
  it("never claims the data has been deleted", () => {
    for (const t of [CONFIRM_TEXT, CLOSED_TITLE, CLOSED_TEXT]) expect(t).not.toMatch(/has been deleted|have been deleted|was deleted|erased/i);
    expect(CONFIRM_TEXT).toMatch(/can't undo/);
  });
  it("close_my_account takes p_via and accepts 'app'", () => {
    expect(MIGRATION).toMatch(/create or replace function close_my_account\(p_via text default 'app'\)/);
    expect(MIGRATION).toContain("p_via not in ('app', 'web')");
  });
  it("older apps keep request/cancel (review 23 Nov), while this app's one-step flow never calls request", () => {
    expect(MIGRATION).toContain("grant execute on function request_account_deletion(text) to authenticated");
    expect(MIGRATION).toContain("grant execute on function cancel_account_deletion() to authenticated");
    const screenSrc = fs.readFileSync(path.join(__dirname, "../components/DeleteAccount.tsx"), "utf8");
    const libSrc = fs.readFileSync(path.join(__dirname, "../lib/accountClosing.ts"), "utf8");
    expect(screenSrc + libSrc).not.toMatch(/request_account_deletion/);   // cancel stays, for an older app's request
  });
});

describe("closeMyAccount", () => {
  it("closes as the person (p_via app), then signs out everywhere", async () => {
    const rpc = jest.fn(async () => ok({ status: "closing" }));
    const signOut = jest.fn(async () => ({ error: null }));
    await expect(closeMyAccount(rpc, signOut)).resolves.toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("close_my_account", { p_via: "app" });
    expect(signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(signOut.mock.invocationCallOrder[0]);
  });
  it("a global sign-out that fails falls back to signing out this device", async () => {
    const signOut = jest.fn().mockResolvedValueOnce({ error: { message: "x" } }).mockResolvedValue({ error: null });
    await closeMyAccount(async () => ok(), signOut);
    expect(signOut.mock.calls).toEqual([[{ scope: "global" }], [{ scope: "local" }]]);
  });
  it("staff and admin are refused with the reason; not signed out", async () => {
    const signOut = jest.fn();
    await expect(closeMyAccount(async () => err("staff_role"), signOut)).resolves.toEqual({ ok: false, message: expect.stringMatching(/staff at a club/) });
    await expect(closeMyAccount(async () => err("admin_role"), signOut)).resolves.toEqual({ ok: false, message: expect.stringMatching(/Admin accounts/) });
    expect(signOut).not.toHaveBeenCalled();
  });
  it("an error after the close committed: the account is closed, so it still signs out", async () => {
    const rpc = jest.fn(async (fn: string) => (fn === "close_my_account" ? err("Network request failed") : ok({ status: "closing", closed: true })));
    const signOut = jest.fn(async () => ({ error: null }));
    await expect(closeMyAccount(rpc, signOut)).resolves.toEqual({ ok: true });
    expect(signOut).toHaveBeenCalled();
  });
  it("an error with nothing closed: 'nothing was changed', still signed in", async () => {
    const rpc = jest.fn(async (fn: string) => (fn === "close_my_account" ? err("Network request failed") : ok(null)));
    const signOut = jest.fn();
    await expect(closeMyAccount(rpc, signOut)).resolves.toEqual({ ok: false, message: CLOSE_FAILED });
    expect(signOut).not.toHaveBeenCalled();
  });
  it("a thrown network error is handled the same way", async () => {
    const rpc = jest.fn(async () => { throw new TypeError("Network request failed"); });
    await expect(closeMyAccount(rpc, jest.fn())).resolves.toEqual({ ok: false, message: CLOSE_FAILED });
  });
});

describe("review 23 Nov", () => {
  it("signed in too long ago: asks for a code; nothing closed, not signed out", async () => {
    const signOut = jest.fn();
    await expect(closeMyAccount(async () => err("reauth_required"), signOut)).resolves.toEqual({ ok: false, reauth: true });
    expect(signOut).not.toHaveBeenCalled();
  });
  it("automatic processing not running: says to try later or use the website; nothing closed", async () => {
    await expect(closeMyAccount(async () => err("processing_unavailable"), jest.fn())).resolves.toEqual({ ok: false, message: PROCESSING_PAUSED });
  });
  it("the code goes to the account's own address and never creates an account; then the same close", async () => {
    const otp = { getUser: async () => ({ data: { user: { email: "p@example.com" } } }), signInWithOtp: jest.fn(async () => ({ error: null })), verifyOtp: jest.fn(async () => ({ error: null })) };
    await expect(sendReauthCode(otp)).resolves.toEqual({ email: "p@example.com" });
    expect(otp.signInWithOtp).toHaveBeenCalledWith({ email: "p@example.com", options: { shouldCreateUser: false } });
    const rpc = jest.fn(async () => ({ data: { status: "closing" }, error: null }));
    await expect(verifyAndClose(otp, rpc, jest.fn(async () => ({ error: null })), "p@example.com", "12 34 56")).resolves.toEqual({ ok: true });
    expect(otp.verifyOtp).toHaveBeenCalledWith({ email: "p@example.com", token: "123456", type: "email" });
    expect(rpc).toHaveBeenCalledWith("close_my_account", { p_via: "app" });
  });
  it("a wrong code closes nothing", async () => {
    const otp = { getUser: async () => ({ data: { user: { email: "p@example.com" } } }), signInWithOtp: jest.fn(), verifyOtp: jest.fn(async () => ({ error: { message: "invalid" } })) };
    const rpc = jest.fn();
    await expect(verifyAndClose(otp, rpc, jest.fn(), "p@example.com", "000000")).resolves.toEqual({ ok: false, message: expect.stringMatching(/code didn't work/) });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("the app's texts for these are the website's", () => {
    const flat = WEB_COPY.replace(/"\s*\+\s*"/g, "");
    expect(flat).toContain(REAUTH_TEXT);
    expect(legacyRequestText("2026-11-23T10:00:00Z")).toMatch(/It will be deleted after 24 November at 12:00 \(Beirut time\) unless you keep it/);
  });
});

describe("signOutIfClosed (cold start, sign-in)", () => {
  it("a closed account is signed out on this device", async () => {
    const signOut = jest.fn(async () => ({ error: null }));
    await expect(signOutIfClosed(async () => ok({ status: "closed", closed: true }), signOut)).resolves.toBe(true);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("an open account, no record, 0079's shape (no 'closed') or an error: nothing happens", async () => {
    const signOut = jest.fn();
    for (const r of [ok(null), ok({ status: "requested", requested_at: "x" }), err("PGRST202")]) {
      await expect(signOutIfClosed(async () => r, signOut)).resolves.toBe(false);
    }
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("the Delete account card", () => {
  const rpc = supabase.rpc as jest.Mock;
  const signOut = supabase.auth.signOut as jest.Mock;
  let alert: jest.SpyInstance;
  beforeEach(() => {
    rpc.mockReset(); signOut.mockReset();
    signOut.mockResolvedValue({ error: null });
    rpc.mockImplementation(async (fn: string) => (fn === "my_account_deletion" ? ok(null) : ok({ status: "closing" })));
    alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  });
  afterEach(() => alert.mockRestore());

  it("one confirmation with the D5 text: Keep my account / Delete my account", async () => {
    await render(<DeleteAccount />);
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, body, buttons] = alert.mock.calls[0];
    expect(title).toBe(CONFIRM_TITLE);
    expect(body).toBe(CONFIRM_TEXT);
    expect(buttons.map((b: { text: string; style: string }) => [b.text, b.style])).toEqual([["Keep my account", "cancel"], ["Delete my account", "destructive"]]);
    expect(rpc).not.toHaveBeenCalledWith("close_my_account", expect.anything());
  });
  it("confirming closes, signs out, and shows the closed message", async () => {
    await render(<DeleteAccount />);
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    void alert.mock.calls[0][2][1].onPress();
    await waitFor(() => expect(alert).toHaveBeenLastCalledWith(CLOSED_TITLE, CLOSED_TEXT));
    expect(rpc).toHaveBeenCalledWith("close_my_account", { p_via: "app" });
    expect(signOut).toHaveBeenCalledWith({ scope: "global" });
  });
  it("a refusal is shown on the card", async () => {
    rpc.mockImplementation(async (fn: string) => (fn === "my_account_deletion" ? ok(null) : err("staff_role")));
    await render(<DeleteAccount />);
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    void alert.mock.calls[0][2][1].onPress();
    expect(await screen.findByText(/staff at a club/)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
  });
  it("before 0079 (function missing): nothing is drawn", async () => {
    rpc.mockImplementation(async () => err("Could not find the function"));
    await render(<DeleteAccount />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("my_account_deletion"));
    await act(async () => {});
    expect(screen.queryByTestId("delete-account")).toBeNull();
  });
});

describe("approved closed wording (Paul, 23 Nov)", () => {
  it("title and first sentence read exactly as approved", () => {
    const { CLOSED_TITLE, CLOSED_TEXT } = require("../lib/accountClosing");
    expect(`${CLOSED_TITLE} ${CLOSED_TEXT}`.startsWith("Your account is closed. We're processing the deletion of your data.")).toBe(true);
  });
});

describe("what is deleted is described in full (M14 data included)", () => {
  it("the app's confirmation names favourite clubs and saved playing areas, as the website does", () => {
    const { CONFIRM_TEXT } = require("../lib/accountClosing");
    expect(CONFIRM_TEXT).toMatch(/favourite clubs, saved playing areas/);
  });
});
