import { useEffect, useState } from "react";
import { Alert, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "./Button";
import { supabase } from "../lib/supabase";
import {
  closeMyAccount, legacyRequestText, REAUTH_TEXT, sendReauthCode, verifyAndClose,
  CLOSED_TEXT, CLOSED_TITLE, CONFIRM_TEXT, CONFIRM_TITLE, type CloseResult,
} from "../lib/accountClosing";
import { color, font, radius, space, text, MAX_FONT_SCALE } from "../lib/theme";
import {
  appleDeletionOn, deleteWithApple, deleteWithFallback, MISMATCH_TEXT, REVOCATION_NOTE, UNKNOWN_TEXT,
  type AppleDeletionOutcome,
} from "../lib/appleDeletion";
import { nativeAppleDeletionDeps } from "../lib/appleDeletionNative";

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
  // E1 (draft, OFF unless EXPO_PUBLIC_APPLE_DELETION=1): Apple-linked accounts confirm with Apple; the email code is
  // the fallback, and then the same server call. Off: everything below works exactly as before.
  const [appleOn, setAppleOn] = useState(false);
  const [fallbackIntent, setFallbackIntent] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    supabase.rpc("my_account_deletion").then(({ data, error }) => { if (live) setMine(error ? undefined : ((data as Mine) ?? null)); });
    // only when the switch is on: with it off, this screen makes exactly the calls it made before E1
    if (process.env.EXPO_PUBLIC_APPLE_DELETION === "1" && Platform.OS === "ios") {
      supabase.auth.getUser().then(({ data }) => {
        if (live) setAppleOn(appleDeletionOn(process.env.EXPO_PUBLIC_APPLE_DELETION, Platform.OS, data.user) && !!nativeAppleDeletionDeps());
      }).catch(() => undefined);
    }
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
  const appleDone = async (o: AppleDeletionOutcome) => {
    switch (o.kind) {
      case "closed":
        setCodeFor(null); setFallbackIntent(null);
        Alert.alert(CLOSED_TITLE, o.revocation === "done" ? CLOSED_TEXT : `${CLOSED_TEXT}\n\n${REVOCATION_NOTE}`); return;
      case "use_fallback": {
        setFallbackIntent(o.intent);
        const sent = await sendReauthCode(supabase.auth);
        if ("email" in sent) { setCodeFor(sent.email); setCode(""); } else setProblem(sent.message);
        return;
      }
      case "not_configured": await done(await closeMyAccount(rpc, signOut)); return;   // the existing flow
      case "account_mismatch": setProblem(MISMATCH_TEXT); return;
      case "unknown": setProblem(UNKNOWN_TEXT); return;
      case "refused": setProblem(o.message); return;
    }
  };
  const close = async () => {
    setBusy(true); setProblem(null);
    const deps = appleOn ? nativeAppleDeletionDeps() : null;
    if (deps) await appleDone(await deleteWithApple(deps));
    else await done(await closeMyAccount(rpc, signOut));
    setBusy(false);
  };
  const confirmCode = async () => {
    if (!codeFor) return;
    setBusy(true); setProblem(null);
    const deps = fallbackIntent ? nativeAppleDeletionDeps() : null;
    if (deps && fallbackIntent) {
      // the fallback: the email code gives the app's own session a recent sign-in, then the same server call
      const { error } = await supabase.auth.verifyOtp({ email: codeFor, token: code.replace(/\D/g, ""), type: "email" });
      if (error) setProblem("That code didn't work. Check it, or send a new one.");
      else await appleDone(await deleteWithFallback(deps, fallbackIntent));
    } else {
      await done(await verifyAndClose(supabase.auth, rpc, signOut, codeFor, code));
    }
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
          <Button label="Keep my account" variant="quiet" disabled={busy} onPress={() => { setCodeFor(null); setFallbackIntent(null); setProblem(null); }} />
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
