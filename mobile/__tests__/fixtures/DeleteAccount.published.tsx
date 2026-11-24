// EXACT COPY of mobile/components/DeleteAccount.tsx as released in the staging app (PR #17 @ ed68d21, OTA group
// 69490212-155b-4d2b-b69d-86911db50674). Kept only to test that apps already installed keep working with 0086.
// Do not edit: tests import it to prove compatibility (review 23 Nov, finding 3). Imports adjusted for this folder.
import { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { supabase } from "../../lib/supabase";
import { color, radius, space, text, MAX_FONT_SCALE } from "../../lib/theme";

/**
 * Profile → Delete account (M2; Apple and Google require deletion inside the app). Asking is immediate; CourtBook
 * processes it (manual at launch) and the person can cancel until then. Same database functions as the website
 * (0079). Before 0079 exists, my_account_deletion is missing and nothing is shown.
 */
type State = { status: "requested" | "data_removed"; requested_at: string } | null;
const MESSAGES: Record<string, string> = {
  staff_role: "You are staff at a club. Ask the club to remove you from its staff first, then try again.",
  admin_role: "Admin accounts cannot be deleted here. Remove the admin role first.",
};
const WHAT = "This deletes your name, phone number, email sign-in, coach profile and chat messages, and takes you out of your games. " +
  "Upcoming bookings are cancelled under the club's normal rules, and games you organise are cancelled. " +
  "Clubs keep past bookings and payments without your name, for their records. You can cancel until we process it.";

export function DeleteAccount() {
  const [state, setState] = useState<State | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    supabase.rpc("my_account_deletion").then(({ data, error }) => { if (live) setState(error ? undefined : ((data as State) ?? null)); });
    return () => { live = false; };
  }, []);
  if (state === undefined) return null;

  const request = () => Alert.alert("Delete your account?", WHAT, [
    { text: "Not now", style: "cancel" },
    { text: "Delete my account", style: "destructive", onPress: async () => {
      setBusy(true); setProblem(null);
      const { data, error } = await supabase.rpc("request_account_deletion", { p_via: "app" });
      setBusy(false);
      if (error) setProblem(MESSAGES[error.message] ?? "That didn't work. Please try again."); else setState(data as State);
    } },
  ]);
  const cancel = async () => {
    setBusy(true); setProblem(null);
    const { error } = await supabase.rpc("cancel_account_deletion");
    setBusy(false);
    if (error) setProblem("That didn't work. Please try again."); else setState(null);
  };
  const date = state ? new Date(state.requested_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";

  return (
    <View style={styles.card} testID="delete-account">
      {state ? (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>
            You asked to delete your account on {date}. We will delete it soon. Until then you can't
            make new bookings, join games or send messages.
          </Text>
          {state.status === "requested" ? <Button label="Keep my account" variant="secondary" busy={busy} onPress={cancel} testID="delete-account-cancel" /> : null}
        </>
      ) : (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.muted}>Permanently delete your CourtBook account and your personal data.</Text>
          <Button label="Delete my account…" variant="quiet" busy={busy} onPress={request} testID="delete-account-request" />
        </>
      )}
      {problem ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.problem} accessibilityRole="alert">{problem}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.md },
  body: { ...text.body, color: color.ink },
  muted: { ...text.caption, color: color.muted },
  problem: { ...text.caption, color: color.danger },
});
