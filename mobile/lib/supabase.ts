import "react-native-url-polyfill/auto";
import { AppState } from "react-native";
import { ChunkedSecureStore } from "./secureStorage";
import { createClient } from "@supabase/supabase-js";

// These two reads must stay exactly this shape — a static dotted property of
// process.env. Expo only inlines that form at build time; destructuring, or
// process.env["..."], is not inlined and arrives undefined on the device.
const rawUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Fail at startup with a readable message rather than a null-pointer deep inside a screen.
if (!rawUrl || !anonKey) {
  throw new Error(
    "Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. " +
      "Set both as EAS environment variables (or in mobile/.env for a local run)."
  );
}

/**
 * supabase-js builds every request as `<url>/rest/v1/...`, so it wants the bare
 * project origin. A value carrying the REST path produces
 * `/rest/v1/rest/v1/rpc/<fn>` and a 404 that looks like a missing function
 * rather than a wrong setting — which is exactly how it presented the first
 * time: "the function exists and the grants are right", and yet 404.
 *
 * The origin is taken and anything else is reported. The app still works with a
 * misconfigured value instead of failing opaquely, and `configNote` carries the
 * reason to the screen, because there is no console on a phone.
 */
function readUrl(value: string): { url: string; note: string | null } {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { url: trimmed, note: `EXPO_PUBLIC_SUPABASE_URL is not a URL: "${trimmed}"` };
  }
  // A bare trailing slash is harmless and common, so it is removed quietly.
  // Anything else on the end is a real misconfiguration and is reported.
  const extra = parsed.pathname.replace(/\/+$/, "") + parsed.search;
  if (extra === "") {
    return { url: parsed.origin, note: null };
  }
  return {
    url: parsed.origin,
    note:
      `EXPO_PUBLIC_SUPABASE_URL should be just ${parsed.origin} — ` +
      `it currently ends with "${extra}". Using ${parsed.origin} anyway; ` +
      `fix the value in the Expo preview environment and rebuild.`,
  };
}

const { url, note } = readUrl(rawUrl);

/** Non-null when the Supabase URL was not what it should have been. Shown on screen. */
export const configNote = note;

/** The project origin (https://<ref>.supabase.co), for public storage addresses. */
export const supabaseOrigin = url;

/** The project host, for error messages. Not a secret — the anon key is, and is never shown. */
export const supabaseHost = url.replace(/^https?:\/\//, "");

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: ChunkedSecureStore,
    autoRefreshToken: true,
    persistSession: true,
    // There is no browser URL to read a session out of on a device.
    detectSessionInUrl: false,
    // The OAuth round trip leaves the app for a browser and comes back through
    // the courtbook:// scheme, so the code is exchanged explicitly on return.
    flowType: "pkce",
  },
});

// Supabase refreshes tokens on a timer. The timer does not run while the app is
// backgrounded, so it is stopped and restarted with the app to avoid firing a
// refresh with a stale token on resume.
AppState.addEventListener("change", (state) => {
  if (state === "active") void supabase.auth.startAutoRefresh();
  else void supabase.auth.stopAutoRefresh();
});
