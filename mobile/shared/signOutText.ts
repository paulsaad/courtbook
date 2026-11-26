/**
 * "Sign out of all devices" (F2 review S3, Paul 26 Nov). Shared with the app (mobile/shared/signOutText.ts).
 *
 * What it does, exactly (Supabase Auth, signOut scope "global"; auth-js 2.119):
 *   - every session of the account is ended on the Auth server, so no device can renew its sign-in (refresh tokens
 *     revoked); this device's own session is removed at once;
 *   - an access token already issued to another device is NOT revoked: it is a signed token checked on its own, so it
 *     keeps working until it expires (the project's JWT expiry; Supabase's default is 1 hour, and the copy below says
 *     so; check both projects' setting before release). The other device is signed out when it next renews.
 *   - if the Auth server cannot be reached (offline), nothing changes: every device, this one included, stays signed in.
 * Ordinary "Sign out" ends this device only. Closing the account ends every session and also bans and deletes the
 * sign-in (account closure, unchanged).
 */
export const SIGN_OUT_ALL = {
  button: "Sign out of all devices",
  title: "Sign out of all devices?",
  body:
    "You'll be signed out here and on every other phone and browser where you use CourtBook. Other devices can stay " +
    "signed in for up to an hour, until their current sign-in runs out. Use this if you lost a phone or signed in on " +
    "someone else's device.",
  confirm: "Sign out everywhere",
  cancel: "Cancel",
  failed: "Couldn't sign out of all devices, so nothing changed: you're still signed in everywhere. Check your connection and try again.",
} as const;
