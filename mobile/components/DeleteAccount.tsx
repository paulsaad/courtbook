import { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "./Button";
import { supabase } from "../lib/supabase";
import {
  closeMyAccount, legacyRequestText, REAUTH_TEXT, sendReauthCode, verifyAndClose,
  CLOSED_TEXT, CLOSED_TITLE, CONFIRM_TEXT, CONFIRM_TITLE, type CloseResult,
} from "../lib/accountClosing";
import { color, font, radius, space, text, MAX_FONT_SCALE } from "../lib/theme";

/**
 * Profile → Delete account (M2, 0086; Apple and Google require deletion inside the app). One confirmation; the account
 * is closed at once and the app signs out (lib/accountClosing.ts). Before 0079/0086 exist, my_account_deletion is
 * missing and nothing is shown.
 * Review 23 Nov: a session not signed in within 10 minutes is asked for an email code first (then the same close, no
 * second confirmation); while automatic processing is not running the app does not close (the database refuses, the
 * card says to try later or use the website); a request made in an older app version shows "Keep my account".
 */
type Mine = { status?: string; requested_at?: string; closed?: boolean } | null;
const rpc = (fn: string, a: Record<string, unknown>) => supabase.rpc(fn, a);
const signOut = (o: { scope: "global" | "local" }) => supabase.auth.signOut(o);

export function DeleteAccount() {
  const [mine, setMine] = useState<Mine | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    let live = true;
    supabase.rpc("my_account_deletion").then(({ data, error }) => { if (live) setMine(error ? undefined : ((data as Mine) ?? null)); });
    return () => { live = false; };
  }, []);
  if (mine === undefined) return null;

  const done = async (r: CloseResult) => {
    if (r.ok) { setCodeFor(null); Alert.alert(CLOSED_TITLE, CLOSED_TEXT); return; }
    if ("reauth" in r) {
      const sent = await sendReauthCode(supabase.auth);
      if ("email" in sent) { setCodeFor(sent.email); setCode(""); } else setProblem(sent.message);
      return;
    }
    setProblem(r.message);
  };
  const close = async () => {
    setBusy(true); setProblem(null);
    await done(await closeMyAccount(rpc, signOut));
    setBusy(false);
  };
  const confirmCode = async () => {
    if (!codeFor) return;
    setBusy(true); setProblem(null);
    await done(await verifyAndClose(supabase.auth, rpc, signOut, codeFor, code));
    setBusy(false);
  };
  const keep = async () => {
    setBusy(true); setProblem(null);
    const { error } = await supabase.rpc("cancel_account_deletion");
    setBusy(false);
    if (error) setProblem("That didn't work. Please try again."); else setMine(null);
  };
  const ask = () => Alert.alert(CONFIRM_TITLE, CONFIRM_TEXT, [
    { text: "Keep my account", style: "cancel" },
    { text: "Delete my account", style: "destructive", onPress: close },
  ]);

  return (
    <View style={styles.card} testID="delete-account">
      {codeFor ? (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>{REAUTH_TEXT} {codeFor}</Text>
          <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code"
            maxLength={10} accessibilityLabel="Sign-in code" style={styles.input} testID="delete-account-code" maxFontSizeMultiplier={MAX_FONT_SCALE} />
          <Button label="Confirm and delete my account" busy={busy} disabled={code.replace(/\D/g, "").length < 6} onPress={confirmCode} testID="delete-account-code-confirm" />
          <Button label="Send a new code" variant="secondary" disabled={busy} onPress={() => void done({ ok: false, reauth: true })} />
          <Button label="Keep my account" variant="quiet" disabled={busy} onPress={() => { setCodeFor(null); setProblem(null); }} />
        </>
      ) : mine?.status === "requested" ? (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>{legacyRequestText(mine.requested_at)}</Text>
          <Button label="Keep my account" variant="secondary" busy={busy} onPress={keep} testID="delete-account-keep" />
          <Button label="Delete my account now…" variant="quiet" disabled={busy} onPress={ask} testID="delete-account-request" />
        </>
      ) : (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.muted}>Permanently delete your CourtBook account and your personal data.</Text>
          <Button label="Delete my account…" variant="quiet" busy={busy} onPress={ask} testID="delete-account-request" />
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
  input: { minHeight: 48, borderWidth: 1, borderColor: color.line, borderRadius: radius.md, paddingHorizontal: space.md, fontFamily: font.semibold, fontSize: 20, letterSpacing: 4, color: color.ink, backgroundColor: color.card },
});
