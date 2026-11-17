/**
 * Which app this is, and which database it may talk to.
 *
 * Two apps are built from this code: CourtBook (app.courtbook.mobile), which uses the live
 * database, and CourtBook Staging (app.courtbook.mobile.staging), which uses the staging database.
 * The app's identity comes from its installed bundle ID — native, fixed at build time, the one
 * thing an over-the-air update cannot change. The database comes from EXPO_PUBLIC_SUPABASE_URL,
 * which is set when the JavaScript is bundled. If the two disagree (for example, a staging update
 * published to the live app's channel, or the reverse) the app refuses to connect at all rather
 * than read or write the wrong database.
 *
 * Project refs are not secrets: they are part of every request URL.
 */
export const PROJECT_REF = {
  production: "lgujfbwunokobjxlvpuf",
  staging: "pwznauyioqykdwodwpvx",
} as const;
export type Variant = keyof typeof PROJECT_REF;

export const BUNDLE_ID: Record<Variant, string> = {
  production: "app.courtbook.mobile",
  staging: "app.courtbook.mobile.staging",
};

export function variantFromAppId(appId: string | null | undefined): Variant | null {
  if (!appId) return null;
  if (appId === BUNDLE_ID.staging) return "staging";
  if (appId === BUNDLE_ID.production) return "production";
  return null;
}

/** "https://abcd.supabase.co" → "abcd"; anything else → null. */
export function refFromUrl(url: string): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

export type ConnectionCheck =
  | { ok: true; variant: Variant | null }
  | { ok: false; message: string };

/**
 * appId null means no native app (the browser layout checks, unit tests): there is nothing to
 * protect and the check is skipped. Any installed app must match exactly.
 */
export function checkConnection(appId: string | null | undefined, url: string): ConnectionCheck {
  if (!appId) return { ok: true, variant: null };
  const variant = variantFromAppId(appId);
  if (!variant) return { ok: false, message: `This app (${appId}) is not a known CourtBook build, so it will not connect to any database.` };
  const ref = refFromUrl(url);
  if (ref !== PROJECT_REF[variant]) {
    const other = (Object.keys(PROJECT_REF) as Variant[]).find((v) => PROJECT_REF[v] === ref);
    const target = other ? `the ${other === "production" ? "live" : "staging"} database` : `an unknown database (${url})`;
    return {
      ok: false,
      message: `This is the ${variant === "staging" ? "CourtBook Staging" : "CourtBook"} app, but it was set up to use ${target}. ` +
        "It will not connect. Install the latest update for this app, or tell the developer.",
    };
  }
  return { ok: true, variant };
}
