import type { ConfigContext, ExpoConfig } from "expo/config";

// Temporary internal staging identifier ("STG" on charcoal; scripts/staging-artwork.py). Not CourtBook branding:
// the final name, logo and icon come from a separate branding decision. Live builds keep the assets named in
// app.json. Which exact files may ship is pinned in assets/artwork-approvals.json (check-store-artwork.mjs).
const STAGING_ASSETS = {
  icon: "./assets/staging/icon.png",
  adaptiveIcon: {
    backgroundColor: "#1F2328",
    foregroundImage: "./assets/staging/android-icon-foreground.png",
    backgroundImage: "./assets/staging/android-icon-background.png",
    monochromeImage: "./assets/staging/android-icon-monochrome.png",
  },
  splashImage: "./assets/staging/splash-icon.png",
  splashBackground: "#1F2328",
} as const;

type PluginEntry = NonNullable<ExpoConfig["plugins"]>[number];

function stagingSplash(plugins: ExpoConfig["plugins"]): ExpoConfig["plugins"] {
  return (plugins ?? []).map((p: PluginEntry): PluginEntry => {
    if (!Array.isArray(p) || p[0] !== "expo-splash-screen") return p;
    const opts = (p[1] ?? {}) as Record<string, unknown>;
    return [
      "expo-splash-screen",
      { ...opts, image: STAGING_ASSETS.splashImage, backgroundColor: STAGING_ASSETS.splashBackground },
    ];
  });
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const base = (process.env.E2E_BUILD === "1"
    ? { ...config, updates: { ...config.updates, enabled: false } }
    : config) as ExpoConfig;
  if (process.env.APP_VARIANT !== "staging") return base;
  return {
    ...base,
    name: "CourtBook Staging",
    scheme: "courtbook-staging",
    icon: STAGING_ASSETS.icon,
    ios: { ...base.ios, bundleIdentifier: "app.courtbook.mobile.staging" },
    android: {
      ...base.android,
      package: "app.courtbook.mobile.staging",
      adaptiveIcon: { ...STAGING_ASSETS.adaptiveIcon },
    },
    plugins: stagingSplash(base.plugins),
  };
};
