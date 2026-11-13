import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "../../lib/supabase";
import { useSession } from "../../lib/session";
import { currentBuild } from "../../lib/buildInfo";
import { Button } from "../../components/Button";
import { Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { color, radius, space, text, MAX_FONT_SCALE } from "../../lib/theme";

/**
 * M1: account and About. About is what Paul reads to say exactly which code he tested — the update
 * ID matches what the Mobile update workflow printed.
 */
export default function Profile() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const build = currentBuild();

  async function signOut() {
    setBusy(true);
    await supabase.auth.signOut();
    // Nothing one person loaded may be shown to the next person on this phone.
    queryClient.clear();
    setBusy(false);
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      {session.status === "loading" ? (
        <Loading label="Checking sign-in" />
      ) : session.status === "signed-out" ? (
        <SignInPrompt title="Your profile" body="Sign in to set your levels, see your activity and manage your account." />
      ) : (
        <View style={styles.card}>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label}>Signed in as</Text>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.value} selectable>
            {session.session.user.email ?? "your account"}
          </Text>
          <Button label="Sign out" variant="secondary" busy={busy} onPress={signOut} />
        </View>
      )}

      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.section}>About this app</Text>
      <View style={styles.card}>
        {build.map((row) => (
          <View key={row.label} style={styles.row}>
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label}>{row.label}</Text>
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.rowValue} selectable>{row.value}</Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.md, paddingBottom: space.xxxl },
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.md },
  section: { ...text.label, color: color.muted, marginTop: space.md },
  label: { ...text.caption, color: color.muted },
  value: { ...text.body, color: color.ink },
  row: { flexDirection: "row", justifyContent: "space-between", gap: space.md },
  rowValue: { ...text.label, color: color.ink, flexShrink: 1, textAlign: "right" },
});
