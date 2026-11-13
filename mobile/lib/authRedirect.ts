import Constants from "expo-constants";

/**
 * Where Google sends the browser back to after sign-in.
 *
 * Two things have to agree on this string: this app, and the Redirect URLs
 * allow list in Supabase (Authentication → URL Configuration). Supabase
 * refuses any redirect that is not on that list and falls back to the Site
 * URL, which on a phone means the browser lands on the website and the app
 * never receives the code.
 *
 * It is derived from the `scheme` in app.json rather than written out twice,
 * so renaming the scheme cannot leave a stale literal behind.
 *
 * The host segment (`auth-callback`) is deliberate. Supabase's own guidance is
 * `[SCHEME]://[HOSTNAME]`, and a redirect carrying only a scheme has been a
 * source of breakage in their auth service, so the bare `courtbook://` form is
 * avoided.
 */

const scheme = Constants.expoConfig?.scheme;
const name = typeof scheme === "string" ? scheme : Array.isArray(scheme) ? scheme[0] : undefined;

if (!name) {
  throw new Error("app.json has no `scheme`, so there is no URL for Google to return to.");
}

export const AUTH_REDIRECT_URL = `${name}://auth-callback`;
