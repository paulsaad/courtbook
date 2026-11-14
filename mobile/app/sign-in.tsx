import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "../lib/supabase";
import { AUTH_REDIRECT_URL } from "../lib/authRedirect";
import { appleAvailable, signInWithApple } from "../lib/appleAuth";
import { color, radius, TOUCH } from "../lib/theme";

type Stage = "email" | "code";

/**
 * Sign-in opens as a sheet over whatever the person was doing (reserving, joining, or a session
 * that expired) and closes back onto it. `returnTo` is only used when there is nothing underneath,
 * e.g. the app was opened straight onto this screen.
 */
export default function SignIn() {
  const { returnTo, reason } = useLocalSearchParams<{ returnTo?: string; reason?: string }>();
  const [apple, setApple] = useState(false);
  useEffect(() => {
    void appleAvailable().then(setApple);
  }, []);

  function finish() {
    if (router.canGoBack()) router.back();
    else router.replace(typeof returnTo === "string" && returnTo.startsWith("/") ? returnTo : "/");
  }

  async function appleSignIn() {
    setBusy(true);
    setError(null);
    const result = await signInWithApple();
    setBusy(false);
    if (result.ok) finish();
    else if (!result.cancelled) setError(result.message ?? "Apple sign-in failed. Use your email instead.");
  }

  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setBusy(false);
    if (error) {
      setError(error.message.includes("rate") ? "Too many requests. Wait a minute and try again." : error.message);
      return;
    }
    setCode("");
    setStage("code");
  }

  async function verifyCode() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) {
      setError("That code is wrong or expired. Check the latest email, or request a new one.");
      return;
    }
    finish();
  }

  async function google() {
    setBusy(true);
    setError(null);
    // The browser must be told to come back to the app rather than to a web
    // page, and Supabase must already have this exact URL on its allow list.
    const redirectTo = AUTH_REDIRECT_URL;
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: "select_account" } },
    });
    if (error || !data?.url) {
      setBusy(false);
      setError("Google sign-in is not available right now. Use your email instead.");
      return;
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== "success") {
      setBusy(false);
      // Dismissed or cancelled: not an error worth shouting about.
      return;
    }

    const returned = Linking.parse(result.url);
    const authCode = typeof returned.queryParams?.code === "string" ? returned.queryParams.code : null;
    if (!authCode) {
      setBusy(false);
      // Overwhelmingly the cause is the redirect URL missing from Supabase's
      // allow list, so the message says where to look rather than just failing.
      setError(
        `Google came back without a sign-in code. Check that ${AUTH_REDIRECT_URL} is on the Redirect URLs list in Supabase.`
      );
      return;
    }

    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(authCode);
    setBusy(false);
    if (exchangeError) {
      setError("Could not finish Google sign-in. Use your email instead.");
      return;
    }
    finish();
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Sign in</Text>
      {reason === "expired" && (
        <Text style={styles.notice}>Your session ended. Sign in again and you'll be back where you were.</Text>
      )}

      {apple && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={radius.md}
          style={styles.apple}
          onPress={busy ? () => {} : appleSignIn}
        />
      )}

      <Pressable style={[styles.secondary, busy && styles.disabled]} onPress={google} disabled={busy}>
        <Text style={styles.secondaryText}>Continue with Google</Text>
      </Pressable>
      {/* Shown so the value can be checked against Supabase during setup
          without reading the source. Remove once Google sign-in has passed. */}
      <Text style={styles.mutedSmall}>Returns to {AUTH_REDIRECT_URL}</Text>

      <View style={styles.divider}>
        <View style={styles.rule} />
        <Text style={styles.mutedSmall}>or</Text>
        <View style={styles.rule} />
      </View>

      {stage === "email" ? (
        <>
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            placeholderTextColor="#9a9a9a"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            inputMode="email"
          />
          <Pressable
            style={[styles.primary, (busy || !email.includes("@")) && styles.disabled]}
            onPress={sendCode}
            disabled={busy || !email.includes("@")}
          >
            <Text style={styles.primaryText}>Email me a code</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.muted}>We sent a 6-digit code to {email.trim()}.</Text>
          <TextInput
            style={styles.input}
            placeholder="123456"
            placeholderTextColor="#9a9a9a"
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            maxLength={6}
          />
          <Pressable
            style={[styles.primary, (busy || code.trim().length < 6) && styles.disabled]}
            onPress={verifyCode}
            disabled={busy || code.trim().length < 6}
          >
            <Text style={styles.primaryText}>Sign in</Text>
          </Pressable>
          <Pressable onPress={() => setStage("email")} hitSlop={8} disabled={busy}>
            <Text style={styles.link}>Use a different email</Text>
          </Pressable>
        </>
      )}

      {busy && <ActivityIndicator style={styles.spinner} />}
      {error !== null && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: color.ground },
  page: { flexGrow: 1, padding: 20, gap: 14, justifyContent: "center" },
  heading: { fontSize: 28, fontWeight: "700", color: color.ink, marginBottom: 4 },
  notice: { fontSize: 15, color: color.warnInk, backgroundColor: color.warnSoft, borderRadius: radius.sm, padding: 12 },
  apple: { height: TOUCH + 4, width: "100%" },
  input: { borderWidth: 1, borderColor: color.line, backgroundColor: color.card, borderRadius: radius.md, paddingHorizontal: 16, minHeight: TOUCH + 4, fontSize: 16, color: color.ink },
  primary: { backgroundColor: color.cedar, borderRadius: radius.md, minHeight: TOUCH + 4, justifyContent: "center", alignItems: "center" },
  primaryText: { color: color.onDark, fontSize: 16, fontWeight: "700" },
  secondary: { borderWidth: 1, borderColor: color.line, backgroundColor: color.card, borderRadius: radius.md, minHeight: TOUCH + 4, justifyContent: "center", alignItems: "center" },
  secondaryText: { color: color.ink, fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  divider: { flexDirection: "row", alignItems: "center", gap: 12 },
  rule: { flex: 1, height: 1, backgroundColor: color.line },
  muted: { fontSize: 14, color: color.muted },
  mutedSmall: { fontSize: 12, color: color.muted },
  link: { fontSize: 15, color: color.cedar, fontWeight: "600", textAlign: "center", paddingVertical: 12 },
  error: { fontSize: 15, color: color.danger },
  spinner: { marginTop: 4 },
});
