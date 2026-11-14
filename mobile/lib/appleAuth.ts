import { Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { supabase } from "./supabase";

/**
 * Sign in with Apple, natively, then hand Apple's identity token to Supabase.
 *
 * The nonce protects against a replayed token: Apple receives the SHA-256 of a fresh random value
 * and signs it into the token; Supabase receives the raw value and checks that it hashes to what
 * Apple signed. A token captured from another sign-in cannot be reused here.
 *
 * Apple gives the person's name only on their very first sign-in to this app, and never inside the
 * token, so it is written to the profile at that moment if the profile has no name yet.
 */
export type AppleResult = { ok: true } | { ok: false; cancelled: boolean; message?: string };

export async function appleAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  return AppleAuthentication.isAvailableAsync();
}

export async function signInWithApple(): Promise<AppleResult> {
  const rawNonce = Crypto.randomUUID() + Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_REQUEST_CANCELED") return { ok: false, cancelled: true };
    return { ok: false, cancelled: false, message: "Apple sign-in is not available right now. Use your email instead." };
  }

  if (!credential.identityToken) {
    return { ok: false, cancelled: false, message: "Apple did not return a sign-in token. Try again." };
  }

  const { data, error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token: credential.identityToken,
    nonce: rawNonce,
  });
  if (error || !data.user) {
    return { ok: false, cancelled: false, message: "Could not finish Apple sign-in. Use your email instead." };
  }

  const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(" ").trim();
  if (name) {
    // Best effort, and only when the profile is still unnamed: never overwrite a name the person set.
    await supabase.from("profiles").update({ name }).eq("id", data.user.id).is("name", null);
  }
  return { ok: true };
}
