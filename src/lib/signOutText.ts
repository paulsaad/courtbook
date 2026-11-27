/**
 * "Sign out of all devices" (F2 review S3, Paul 26 Nov; follow-up 27 Nov). Shared with the app
 * (mobile/shared/signOutText.ts).
 *
 * What it does, exactly (Supabase Auth /logout?scope=global; auth-js 2.119; src/lib/signOutAll.ts):
 *   - when the Auth server confirms, every session of the account has ended there, so no device can renew its
 *     sign-in (refresh tokens revoked); this device's own session is then removed;
 *   - an access token already issued to another device is NOT revoked: it is a signed token checked on its own and
 *     keeps working until it expires, at the project's JWT expiry. That setting was NOT verified for either project
 *     (no read access, 27 Nov), so the copy names no duration; check both projects before release;
 *   - not confirmed (offline, a server error): this device stays signed in and the screen says the others may still
 *     be signed in. This device's session already ended: this device is signed out and the screen says the others
 *     could not be signed out from here.
 * Ordinary "Sign out" ends this device only. Closing the account also asks for every session to end, and then bans
 * and deletes the sign-in (account closure; the database lock-out applies from the moment it closes).
 */
export const SIGN_OUT_ALL = {
  button: "Sign out of all devices",
  title: "Sign out of all devices?",
  body:
    "You'll be signed out here, and no other phone or browser where you use CourtBook will be able to renew its " +
    "sign-in. A device that's already open may stay signed in for a while, until its current sign-in runs out. Use " +
    "this if you lost a phone or signed in on someone else's device.",
  confirm: "Sign out everywhere",
  cancel: "Cancel",
  // re-review R103-2: never "nothing changed" (the request may have reached the server and its answer been lost)
  failed: "Couldn't sign out of all devices. Check your connection and try again. Until it works, treat your other devices as still signed in.",
  // follow-up 27 Nov: this device is now shown signed out (it was left looking signed in)
  thisDeviceEnded: "This device's sign-in had already ended, so your other devices couldn't be signed out from here. You're now signed out on this device. Sign in again, then use Sign out of all devices.",
} as const;
