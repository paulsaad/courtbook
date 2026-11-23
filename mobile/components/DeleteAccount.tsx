import { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { supabase } from "../lib/supabase";
import { closeMyAccount, CLOSED_TEXT, CLOSED_TITLE, CONFIRM_TEXT, CONFIRM_TITLE } from "../lib/accountClosing";
import { color, radius, space, text, MAX_FONT_SCALE } from "../lib/theme";

/**
 * Profile → Delete account (M2, 0086; Apple and Google require deletion inside the app). One confirmation; the account
 * is closed at once and the app signs out (lib/accountClosing.ts). Before 0079/0086 exist, my_account_deletion is
 * missing and nothing is shown.
 */
export function DeleteAccount() {
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    supabase.rpc("my_account_deletion").then(({ error }) => { if (live) setAvailable(!error); });
    return () => { live = false; };
  }, []);
  if (!available) return null;

  const close = async () => {
    setBusy(true); setProblem(null);
    const r = await closeMyAccount((fn, a) => supabase.rpc(fn, a), (o) => supabase.auth.signOut(o));
    setBusy(false);
    if (r.ok) Alert.alert(CLOSED_TITLE, CLOSED_TEXT);
    else setProblem(r.message);
  };
  const ask = () => Alert.alert(CONFIRM_TITLE, CONFIRM_TEXT, [
    { text: "Keep my account", style: "cancel" },
    { text: "Delete my account", style: "destructive", onPress: close },
  ]);

  return (
    <View style={styles.card} testID="delete-account">
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.muted}>Permanently delete your CourtBook account and your personal data.</Text>
      <Button label="Delete my account…" variant="quiet" busy={busy} onPress={ask} testID="delete-account-request" />
      {problem ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.problem} accessibilityRole="alert">{problem}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.md },
  muted: { ...text.caption, color: color.muted },
  problem: { ...text.caption, color: color.danger },
});
