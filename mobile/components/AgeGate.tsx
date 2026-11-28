import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { supabase } from "../lib/supabase";
import { signOutThisDevice } from "../lib/signOut";
import { useSession } from "../lib/session";
import { useAgeState, useConfirmAge } from "../lib/age";
import { color, font, space, text, MAX_FONT_SCALE } from "../lib/theme";

/**
 * Full-screen question over the whole app for a signed-in person who has not confirmed they are 18 or over (0080).
 * Signed-out browsing is unaffected. "No" records nothing: the person is told CourtBook is not for them and can sign out
 * (this phone only, as every ordinary sign-out: F2).
 */
export function AgeGate() {
  const session = useSession();
  const state = useAgeState(session.status === "signed-in");
  const confirm = useConfirmAge();
  const [under, setUnder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (session.status !== "signed-in" || state !== "needed") return null;

  return (
    <View style={styles.cover} accessibilityViewIsModal testID="age-gate">
      <View style={styles.box}>
        {under ? (
          <>
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.title} accessibilityRole="header">CourtBook is for ages 18 and over</Text>
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>You can&apos;t book courts, join games or chat on CourtBook.</Text>
            <Button label="Sign out" variant="secondary" onPress={() => void signOutThisDevice(supabase.auth)} testID="age-signout" />
            <Button label="I answered by mistake" variant="quiet" onPress={() => setUnder(false)} testID="age-back" />
          </>
        ) : (
          <>
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.title} accessibilityRole="header">Are you 18 or over?</Text>
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>
              CourtBook is for people aged 18 and over. We ask once and keep only your answer and when you gave it — no date of birth.
            </Text>
            <Button label="Yes, I am 18 or over" busy={busy} testID="age-yes" onPress={async () => {
              setBusy(true); setProblem(null);
              const p = await confirm();
              setBusy(false); setProblem(p);
            }} />
            <Button label="No, I am under 18" variant="secondary" disabled={busy} onPress={() => setUnder(true)} testID="age-no" />
            {problem ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.problem} accessibilityRole="alert">{problem}</Text> : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.ground, justifyContent: "center", padding: space.xl, zIndex: 100 },
  box: { gap: space.md },
  title: { fontFamily: font.display, fontSize: 24, lineHeight: 30, color: color.ink },
  body: { ...text.body, color: color.ink },
  problem: { ...text.caption, color: color.danger },
});
