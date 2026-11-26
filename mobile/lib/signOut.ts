/**
 * F2 (Paul, 26 Nov): the Profile screen's "Sign out" ends THIS phone's session only; the person's other devices (a
 * desk browser, another phone) stay signed in. Account closure ends every session (accountClosing.ts, scope "global").
 * Offline: auth-js 2.119 removes the session on the phone before it asks Supabase Auth to revoke it, so the phone is
 * signed out even with no connection. The server session is then NOT revoked: it stays valid until revoked: by
 * Supabase's default it never expires (unless the project sets a time-box or inactivity timeout; not set or verified
 * for our projects), so "Sign out of all devices" (below) or
 * account closure ends it. With the previous default (global), an offline sign-out failed and the phone stayed
 * signed in. Online, the session is revoked; an access token already issued stays usable until it expires (≤ 1 h by
 * default) for every scope.
 */
type Auth = { signOut: (opts: { scope: "local" }) => PromiseLike<unknown> };
export const signOutThisDevice = (auth: Auth) => auth.signOut({ scope: "local" });

/** "Sign out of all devices": shared with the website (shared/signOutAll.ts: the Auth server confirms the revocation
 *  before this phone is cleared; re-review R103-1). */
export { signOutAllDevices } from "../shared/signOutAll";
