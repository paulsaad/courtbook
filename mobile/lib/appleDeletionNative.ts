import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { createClient } from "@supabase/supabase-js";
import { supabase, supabaseOrigin } from "./supabase";
import { installedVariant } from "./appIdentity";
import type { Variant } from "./variant";
import type { AppleDeletionDeps, Session } from "./appleDeletion";

/**
 * E1 (draft, OFF): the real dependencies of lib/appleDeletion.ts. Used only when EXPO_PUBLIC_APPLE_DELETION=1 on iOS
 * (appleDeletionOn); no distributed build sets it. The website server is fixed per installed app (never read from
 * configuration), like the payment server: the staging app talks only to the staging website, the live app only to
 * the live one.
 */
export const DELETION_SERVER: Record<Variant, string> = {
  production: "https://courtbook-three.vercel.app",
  staging: "https://courtbook-staging-git-staging-web-paul-bc50.vercel.app",
};

const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** A Supabase client that keeps its session in memory only and never touches the app's own stored session. */
export function ephemeralClient() {
  return createClient(supabaseOrigin, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storage: undefined },
  });
}

export function nativeAppleDeletionDeps(): AppleDeletionDeps | null {
  if (Platform.OS !== "ios" || !installedVariant) return null;
  const server = DELETION_SERVER[installedVariant];
  return {
    mainSession: async (): Promise<Session | null> => {
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      return s?.user?.id && s.access_token ? { userId: s.user.id, accessToken: s.access_token } : null;
    },
    post: async (path, token, body) => {
      try {
        const r = await fetch(`${server}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        let json: unknown = null;
        try { json = await r.json(); } catch { /* not JSON */ }
        return { status: r.status, body: json };
      } catch {
        return null;
      }
    },
    nonce: async () => {
      const raw = Crypto.randomUUID() + Crypto.randomUUID();
      return { raw, hashed: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw) };
    },
    appleSheet: async (hashedNonce) => {
      try {
        const c = await AppleAuthentication.signInAsync({ requestedScopes: [], nonce: hashedNonce });
        return c.identityToken && c.authorizationCode ? { identityToken: c.identityToken, authorizationCode: c.authorizationCode } : "unavailable";
      } catch (e) {
        return (e as { code?: string }).code === "ERR_REQUEST_CANCELED" ? "cancelled" : "unavailable";
      }
    },
    freshSignIn: async (identityToken, rawNonce) => {
      const c = ephemeralClient();
      const { data, error } = await c.auth.signInWithIdToken({ provider: "apple", token: identityToken, nonce: rawNonce });
      if (error || !data.session?.user?.id) return null;
      return {
        userId: data.session.user.id,
        accessToken: data.session.access_token,
        signOut: async () => { await c.auth.signOut({ scope: "local" }); },
      };
    },
    closedNow: async () => {
      const { data, error } = await supabase.rpc("my_account_deletion");
      if (error) return null;
      return !!(data && typeof data === "object" && (data as { closed?: unknown }).closed === true);
    },
    signOutEverywhere: async () => {
      const r = await supabase.auth.signOut({ scope: "global" });
      if (r.error) await supabase.auth.signOut({ scope: "local" });
    },
  };
}
