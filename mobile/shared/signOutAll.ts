/**
 * "Sign out of all devices" (F2 review S3; re-review R103-1, 26 Nov; follow-up 27 Nov) and account closure's
 * sign-out. Shared with the app (mobile/shared/signOutAll.ts).
 *
 * Not auth.signOut({ scope: "global" }): auth-js 2.119 treats a 401, 403 or 404 from /logout as "already signed out",
 * clears this device and reports success, although nothing was revoked (its own comment says so). The other devices
 * would stay signed in while the screen said they were not. So the revocation is asked for directly:
 *   1. this device's session (getSession refreshes an expired access token first);
 *   2. auth.admin.signOut(access token, "global"): the plain /logout?scope=global request; every error is returned;
 *   3. auth.signOut({ scope: "local" }) clears this device: after the server confirmed, or when this device's session
 *      has already ended (then the app and the website show this device as signed out, not still signed in).
 * What is never claimed: an access token already issued to another device is not revoked by any of this; it works
 * until it expires (the project's JWT expiry). See src/lib/signOutText.ts.
 */
type Session = { access_token: string } | null;
type AuthErr = { name?: string; code?: string; status?: number } | null | undefined;
export type SignOutAllAuth = {
  getSession: () => PromiseLike<{ data: { session: Session }; error: unknown }>;
  admin: { signOut: (jwt: string, scope: "global") => PromiseLike<{ error: AuthErr }> };
  signOut: (opts: { scope: "local" }) => PromiseLike<unknown>;
};

/**
 * revoked: the Auth server confirmed every session of the account ended.
 * ended:   this device's session had already ended on the server (or its renewal was refused), so nothing could be
 *          asked from here; this device is cleared.
 * failed:  not confirmed (offline, a server error, any other refusal); this device is left as it was.
 */
export type Revocation = "revoked" | "ended" | "failed";

// the session is gone on the server: /logout answers session_not_found / user_not_found (auth-js maps
// session_not_found to AuthSessionMissingError, which carries no code)
const sessionGone = (e: AuthErr) =>
  !!e && (e.name === "AuthSessionMissingError" || e.code === "session_not_found" || e.code === "user_not_found");
// offline or the server unreachable: auth-js keeps the (expired) session; nothing is known to have ended
const unreachable = (e: AuthErr) => !!e && (e.name === "AuthRetryableFetchError" || e.status === 0);

async function clearThisDevice(auth: SignOutAllAuth) {
  try { await auth.signOut({ scope: "local" }); } catch { /* local sign-out removes the session first (auth-js) */ }
}

export async function revokeAllSessions(auth: SignOutAllAuth): Promise<Revocation> {
  try {
    const { data, error } = await auth.getSession();
    if (error) {
      // auth-js returns an error here only when it could not renew an expired access token. Offline: the session is
      // kept and may still be valid on the server. Refused (expired, revoked, banned): auth-js already removed it.
      if (unreachable(error as AuthErr)) return "failed";
      await clearThisDevice(auth);
      return "ended";
    }
    if (!data.session) return "ended";
    const r = await auth.admin.signOut(data.session.access_token, "global");
    if (r.error) {
      if (!sessionGone(r.error)) return "failed";
      await clearThisDevice(auth);
      return "ended";
    }
    await clearThisDevice(auth);
    return "revoked";
  } catch {
    return "failed";
  }
}

export type SignOutAllResult = { ok: true } | { ok: false; reason: "this_device_ended" | "failed" };

export async function signOutAllDevices(auth: SignOutAllAuth): Promise<SignOutAllResult> {
  const r = await revokeAllSessions(auth);
  if (r === "revoked") return { ok: true };
  return { ok: false, reason: r === "ended" ? "this_device_ended" : "failed" };
}
