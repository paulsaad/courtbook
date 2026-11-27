// Every branch of revokeAllSessions (src/lib/signOutAll.ts, shared with the app), with a stand-in for auth-js, so a
// branch cannot drift unseen: "revoked" only on the server's confirmation (review of 3e7c25d, findings 1 and 3).
import { describe, expect, it, vi } from "vitest";
import { revokeAllSessions, signOutAllDevices, type SignOutAllAuth } from "@/lib/signOutAll";

type Err = { name?: string; code?: string; status?: number } | null;
function fakeAuth({ session = { access_token: "t" } as { access_token: string } | null, sessionError = null as Err, logout = null as Err, local = null as Err } = {}) {
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: sessionError ? null : session }, error: sessionError })),
    admin: { signOut: vi.fn(async () => ({ error: logout })) },
    signOut: vi.fn(async () => ({ error: local })),
  };
  return auth as typeof auth & SignOutAllAuth;
}

describe("revokeAllSessions", () => {
  it("confirmed by the server: revoked, then this device cleared", async () => {
    const a = fakeAuth();
    expect(await revokeAllSessions(a)).toBe("revoked");
    expect(a.admin.signOut).toHaveBeenCalledWith("t", "global");
    expect(a.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("no session on this device: ended, and nothing is asked of the server (never 'revoked')", async () => {
    const a = fakeAuth({ session: null });
    expect(await revokeAllSessions(a)).toBe("ended");
    expect(a.admin.signOut).not.toHaveBeenCalled();
    expect(await signOutAllDevices(fakeAuth({ session: null }))).toEqual({ ok: false, reason: "this_device_ended" });
  });
  it("renewal refused and this device cleared: ended", async () => {
    const a = fakeAuth({ sessionError: { name: "AuthApiError", status: 400, code: "refresh_token_not_found" } });
    expect(await revokeAllSessions(a)).toBe("ended");
    expect(a.admin.signOut).not.toHaveBeenCalled();
  });
  it("renewal refused but the local sign-out answers an error (auth-js retry cool-down): failed, never 'signed out'", async () => {
    const e = { name: "AuthApiError", status: 400, code: "refresh_token_not_found" };
    const a = fakeAuth({ sessionError: e, local: e });
    expect(await revokeAllSessions(a)).toBe("failed");
  });
  it("renewal unreachable (offline): failed; this device is not touched", async () => {
    const a = fakeAuth({ sessionError: { name: "AuthRetryableFetchError", status: 0 } });
    expect(await revokeAllSessions(a)).toBe("failed");
    expect(a.signOut).not.toHaveBeenCalled();
  });
  it.each([["AuthSessionMissingError", undefined], ["AuthApiError", "session_not_found"], ["AuthApiError", "user_not_found"]])(
    "server says the session is gone (%s %s): ended, this device cleared", async (name, code) => {
      const a = fakeAuth({ logout: { name, code, status: 404 } });
      expect(await revokeAllSessions(a)).toBe("ended");
      expect(a.signOut).toHaveBeenCalledWith({ scope: "local" });
    });
  it.each([[401], [403], [404], [429], [500]])("any other refusal (%i): failed; this device is not touched", async (status) => {
    const a = fakeAuth({ logout: { name: "AuthApiError", status } });
    expect(await revokeAllSessions(a)).toBe("failed");
    expect(a.signOut).not.toHaveBeenCalled();
  });
  it("a thrown error: failed", async () => {
    const a = fakeAuth();
    a.getSession.mockRejectedValueOnce(new Error("boom"));
    expect(await revokeAllSessions(a)).toBe("failed");
  });
});
