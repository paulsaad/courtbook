/**
 * "Sign out of all devices" (F2 review S3; re-review R103-1, 26 Nov). Shared with the app (mobile/shared/signOutAll.ts).
 *
 * Not auth.signOut({ scope: "global" }): auth-js 2.119 treats a 401, 403 or 404 from /logout as "already signed out",
 * clears this device and reports success, although nothing was revoked (its own comment says so). The other devices
 * would stay signed in while the screen said they were not. So the revocation is asked for directly, and this device
 * is cleared only after the Auth server has confirmed it:
 *   1. this device's session (getSession refreshes an expired access token first);
 *   2. auth.admin.signOut(access token, "global"): the plain /logout?scope=global request; every error is returned;
 *   3. only then auth.signOut({ scope: "local" }) clears this device.
 * Any failure: this device stays signed in and the caller says so (never "signed out everywhere").
 */
type Session = { access_token: string } | null;
export type SignOutAllAuth = {
  getSession: () => PromiseLike<{ data: { session: Session }; error: unknown }>;
  admin: { signOut: (jwt: string, scope: "global") => PromiseLike<{ error: { name?: string; code?: string; status?: number } | null }> };
  signOut: (opts: { scope: "local" }) => PromiseLike<unknown>;
};
export type SignOutAllResult = { ok: true } | { ok: false; reason: "this_device_ended" | "failed" };

export async function signOutAllDevices(auth: SignOutAllAuth): Promise<SignOutAllResult> {
  try {
    const { data, error } = await auth.getSession();
    if (error || !data.session) return { ok: false, reason: "failed" };
    const r = await auth.admin.signOut(data.session.access_token, "global");
    if (r.error) {
      // this device's own session (or account) no longer exists on the server: nothing could be revoked from it.
      // auth-js 2.119 turns Auth's 403 session_not_found into AuthSessionMissingError (no code); user_not_found keeps its code
      const gone = r.error.name === "AuthSessionMissingError" || r.error.code === "session_not_found" || r.error.code === "user_not_found";
      return { ok: false, reason: gone ? "this_device_ended" : "failed" };
    }
    try { await auth.signOut({ scope: "local" }); } catch { /* revoked on the server; this device is cleared next start */ }
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
