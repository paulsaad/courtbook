/**
 * F2 (Paul, 26 Nov): the Profile screen's "Sign out" ends THIS phone's session only; the person's other devices (a
 * desk browser, another phone) stay signed in. Account closure ends every session (accountClosing.ts, scope "global").
 * Offline: auth-js 2.119 removes the session on the phone before it asks Supabase Auth to revoke it, so the phone is
 * signed out even with no connection (the session then stays valid on the Auth server until it expires). With the
 * previous default (global), an offline sign-out failed and the phone stayed signed in.
 */
type Auth = { signOut: (opts: { scope: "local" }) => PromiseLike<unknown> };
export const signOutThisDevice = (auth: Auth) => auth.signOut({ scope: "local" });
