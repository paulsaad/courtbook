import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Two apps from one code base (see lib/variant.ts):
 *   default             → CourtBook          app.courtbook.mobile          live database
 *   APP_VARIANT=staging → CourtBook Staging  app.courtbook.mobile.staging  staging database
 * The staging app installs beside the real one, has its own name, scheme and update channel, and
 * refuses to connect to the live database. app.json stays the single source of everything else.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  // E2E_BUILD: the emulator test build made on GitHub (no EAS). It must run exactly the code it was
  // built with, so it never fetches over-the-air updates.
  const base = (process.env.E2E_BUILD === "1"
    ? { ...config, updates: { ...config.updates, enabled: false } }
    : config) as ExpoConfig;
  if (process.env.APP_VARIANT !== "staging") return base;
  return {
    ...base,
    name: "CourtBook Staging",
    scheme: "courtbook-staging",
    ios: { ...base.ios, bundleIdentifier: "app.courtbook.mobile.staging" },
    android: { ...base.android, package: "app.courtbook.mobile.staging" },
  };
};
