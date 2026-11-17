import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";
import { color, radius, TOUCH } from "../lib/theme";

/** Shown under a failed test sign-in; the password field has just been emptied. */
export const STAGING_SIGN_IN_RETRY = "The password field has been cleared — enter the password again.";

/**
 * CourtBook Staging only: sign in to a test account with a password. Staging cannot send email to
 * arbitrary addresses, and automated tests need to sign in without one. The live app never shows
 * this — the check is on the installed bundle ID, which no over-the-air update can change — and
 * live accounts have no passwords.
 *
 * After a failed attempt the password field is emptied. It used to keep its hidden contents, so a
 * password pasted or typed for the next attempt was added after the old characters and every retry
 * on the same screen failed with "Invalid login credentials" (Galaxy A17 test, 17 Nov 2026; reproduced
 * on an Android emulator). Autofill is off for both fields, so nothing can be filled in unseen.
 */
export function StagingPasswordSignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setPassword("");
      setError("Test sign-in failed: " + error.message + "\n" + STAGING_SIGN_IN_RETRY);
    } else onDone();
  }
  return (
    <View style={styles.staging}>
      <Text style={styles.stagingTitle}>Staging test account</Text>
      <TextInput testID="staging-email" accessibilityLabel="Test account email" style={styles.input} value={email} onChangeText={setEmail}
        autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="test email" placeholderTextColor="#9a9a9a"
        autoComplete="off" importantForAutofill="no" textContentType="none" />
      <TextInput testID="staging-password" accessibilityLabel="Test account password" style={styles.input} value={password} onChangeText={setPassword}
        secureTextEntry placeholder="password" placeholderTextColor="#9a9a9a"
        autoComplete="off" importantForAutofill="no" textContentType="none" />
      <Pressable testID="staging-sign-in" accessibilityRole="button" style={[styles.secondary, busy && styles.disabled]} onPress={go} disabled={busy}>
        <Text style={styles.secondaryText}>Sign in to the test account</Text>
      </Pressable>
      {error !== null && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  staging: { marginTop: 12, padding: 14, gap: 10, borderRadius: radius.md, borderWidth: 1, borderColor: color.warnInk, backgroundColor: color.warnSoft },
  stagingTitle: { fontSize: 14, fontWeight: "700", color: color.warnInk },
  input: { borderWidth: 1, borderColor: color.line, backgroundColor: color.card, borderRadius: radius.md, paddingHorizontal: 16, minHeight: TOUCH + 4, fontSize: 16, color: color.ink },
  secondary: { borderWidth: 1, borderColor: color.line, backgroundColor: color.card, borderRadius: radius.md, minHeight: TOUCH + 4, justifyContent: "center", alignItems: "center" },
  secondaryText: { color: color.ink, fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  error: { fontSize: 15, color: color.danger },
});
