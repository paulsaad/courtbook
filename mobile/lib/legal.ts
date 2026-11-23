import { Linking } from "react-native";
import * as WebBrowser from "expo-web-browser";

/**
 * M5: the legal pages live on the public website, so the app, the website and both store listings show the same text.
 * WEBSITE_URL is the live website. It changes when the product domain is decided (Paul): change it here only.
 * Both apps (live and staging) link to the live pages: the staging website preview is behind a Vercel login.
 * Release order (docs/m5/store-package.md §1a): no screen links here yet. The links (sign-in, Help) are in a
 * separate, deferred PR, merged only after the pages are legally approved, published and public. Once a screen imports
 * this file, scripts/check-legal-pages.mjs --gate refuses live builds and updates until every linked page is final.
 */
export const WEBSITE_URL = "https://courtbook-three.vercel.app";

export const LEGAL_PAGES = [
  { key: "privacy", label: "Privacy policy", url: `${WEBSITE_URL}/privacy` },
  { key: "terms", label: "Terms of use", url: `${WEBSITE_URL}/terms` },
  { key: "delete-account", label: "Deleting your account", url: `${WEBSITE_URL}/delete-account` },
] as const;

/** Opens a legal page in the in-app browser (Safari / Chrome custom tab), or the phone's browser if that fails. */
export async function openLegalPage(url: string): Promise<void> {
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    await Linking.openURL(url).catch(() => undefined);
  }
}
