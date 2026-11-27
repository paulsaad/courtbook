import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as Updates from "expo-updates";
import { supabase } from "../../lib/supabase";
import { signOutAllDevices, signOutThisDevice } from "../../lib/signOut";
import { SIGN_OUT_ALL } from "@shared/signOutText";
import { useSession } from "../../lib/session";
import { currentBuild } from "../../lib/buildInfo";
import { initials, useProfileName } from "../../lib/profile";
import { missingForBooking, useMyProfile } from "../../lib/myProfile";
import { useMyLevels } from "../../lib/games";
import { levelLabel } from "@shared/levels";
import { sportName } from "../../lib/days";
import { LevelSheet } from "../../components/LevelSheet";
import { Chip } from "../../components/Chip";
import { installedVariant as appVariant } from "../../lib/appIdentity";
import { Button } from "../../components/Button";
import { Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { Segmented } from "../../components/Segmented";
import { Icon } from "../../components/Icon";
import { badgeText, unreadCount, useActivity } from "../../lib/activity";
import { FAULT_LABEL, currentFault, faultsAvailable, setFault, subscribeFault, type Fault } from "../../lib/testFaults";
import { E2E_PROBES, crashNatively, sendPrivacyProbe, sendTestReport } from "../../lib/crash";
import { useSafety } from "../../lib/safety";
import { BlockedPlayers } from "../../components/BlockedPlayers";
import { DeleteAccount } from "../../components/DeleteAccount";
import { color, font, radius, space, text, MAX_FONT_SCALE, TOUCH } from "../../lib/theme";

/**
 * M1: account and About. About is what Paul reads to say exactly which code he tested — the update
 * ID matches what the Mobile update workflow printed.
 */
/** Profile → Activity, with the unread count in words and as a badge (§4.7). */
function ActivityLink() {
  const q = useActivity({ signedIn: true });
  const n = unreadCount(q.data);
  const badge = badgeText(n);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={n ? `Activity, ${n} unread` : "Activity"} onPress={() => router.push("/activity")}
               style={({ pressed }) => [styles.card, styles.activity, pressed && { opacity: 0.85 }]} testID="profile-activity">
      <Icon name="bell" size={22} color={color.cedarDeep} />
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.activityText}>Activity</Text>
      {badge ? <View style={styles.badge}><Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.badgeText}>{badge}</Text></View> : null}
      <Icon name="chevronRight" size={20} color={color.muted} />
    </Pressable>
  );
}

export default function Profile() {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const build = [
    ...(appVariant === "staging" ? [{ label: "App", value: "CourtBook Staging (test database)" }] : []),
    ...currentBuild(),
  ];
  const fault = useSyncExternalStore(subscribeFault, currentFault);
  const [reportSent, setReportSent] = useState(false);
  const [probeSent, setProbeSent] = useState(false);
  const name = useProfileName(session.status === "signed-in" ? session.session.user.id : null);
  const email = session.status === "signed-in" ? session.session.user.email ?? null : null;
  const shownName = name.data?.trim() || null;
  const safety = useSafety(session.status === "signed-in");
  const userId = session.status === "signed-in" ? session.session.user.id : null;
  const details = useMyProfile(userId);
  const levels = useMyLevels({ signedIn: !!userId });
  const [levelFor, setLevelFor] = useState<string | null>(null);
  const missing = details.data ? missingForBooking(details.data) : [];

  async function signOut() {
    setBusy(true);
    // The session provider empties the cache on every sign-out, however it happens.
    // F2: this phone only (lib/signOut.ts); account closure still signs out everywhere (lib/accountClosing.ts)
    await signOutThisDevice(supabase.auth);
    setBusy(false);
  }
  // F2 review S3: every device (Supabase global sign-out), after a confirmation; see shared/signOutText.ts
  const [allProblem, setAllProblem] = useState<string | null>(null);
  // the "already ended" message is for the signed-out screen; signing in again clears it
  useEffect(() => {
    if (session.status === "signed-in") setAllProblem((p) => (p === SIGN_OUT_ALL.thisDeviceEnded ? null : p));
  }, [session.status]);
  function signOutEverywhere() {
    setAllProblem(null);
    Alert.alert(SIGN_OUT_ALL.title, SIGN_OUT_ALL.body, [
      { text: SIGN_OUT_ALL.cancel, style: "cancel" },
      { text: SIGN_OUT_ALL.confirm, style: "destructive", onPress: async () => {
        setBusy(true);
        const r = await signOutAllDevices(supabase.auth);
        setBusy(false);
        // failed: this phone stays signed in; the others may be too (the server did not confirm)
        // this_device_ended: this phone is now signed out too (follow-up 27 Nov), and the message stays on screen
        if (!r.ok) setAllProblem(r.reason === "this_device_ended" ? SIGN_OUT_ALL.thisDeviceEnded : SIGN_OUT_ALL.failed);
      } },
    ]);
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      {session.status === "loading" ? (
        <Loading label="Checking sign-in" />
      ) : session.status === "signed-out" ? (
        <>
          {allProblem ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.problem} accessibilityRole="alert" testID="profile-signout-all-problem">{allProblem}</Text> : null}
          <SignInPrompt title="Your profile" body="Sign in to set your levels, see your activity and manage your account." />
        </>
      ) : (
        <View style={styles.card}>
          <View style={styles.who}>
            <View style={styles.avatar} accessible={false}>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.initials}>{initials(shownName ?? email)}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.name} numberOfLines={2}>{shownName ?? "Signed in"}</Text>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label} selectable numberOfLines={1}>{email ?? "your account"}</Text>
            </View>
          </View>
          <View style={styles.detailRows} testID="profile-details">
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label}>Contact phone</Text>
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={details.data?.phone ? styles.value : styles.missing} selectable>
              {details.isError && !details.data ? "Couldn't load" : details.data ? details.data.phone ?? "Not added yet — needed to book a court" : "…"}
            </Text>
            {missing.includes("name") && details.data ? (
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.missing}>Add your name — clubs see it on your bookings.</Text>
            ) : null}
          </View>
          <Button label={missing.length ? "Add your details" : "Edit your details"} variant="quiet" onPress={() => router.push("/my-details")} testID="profile-edit-details" />
          <Button label="Sign out" variant="secondary" busy={busy} onPress={signOut} />
          <Button label={SIGN_OUT_ALL.button} variant="quiet" disabled={busy} onPress={signOutEverywhere} testID="profile-signout-all" />
          {allProblem ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.problem} accessibilityRole="alert">{allProblem}</Text> : null}
        </View>
      )}
      {userId ? (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.section}>Sports and levels</Text>
          <View style={styles.card} testID="profile-levels">
            {details.data && details.data.sports.length > 0 ? (
              <View style={styles.levelChips}>
                {details.data.sports.map((sp) => (
                  <Chip key={sp} label={`${sportName(sp)} · ${levels.data?.[sp] != null ? levelLabel(levels.data[sp]) : "Set your level"}`}
                        onPress={() => setLevelFor(sp)} testID={`level-chip-${sp}`} />
                ))}
              </View>
            ) : (
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label}>Add the sports you play, then a level for each. Optional — it helps you find games that suit you.</Text>
            )}
            <Button label={details.data?.sports.length ? "Change sports" : "Add sports"} variant="quiet" onPress={() => router.push("/my-details")} testID="profile-sports" />
          </View>
          <LevelSheet sport={levelFor} sportName={levelFor ? sportName(levelFor) : ""} current={levelFor ? levels.data?.[levelFor] ?? null : null} onClose={() => setLevelFor(null)} />
        </>
      ) : null}
      {session.status === "signed-in" ? <ActivityLink /> : null}
      {session.status === "signed-in" ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Where I play" onPress={() => router.push("/areas")}
                   style={({ pressed }) => [styles.card, styles.activity, pressed && { opacity: 0.85 }]} testID="profile-areas">
          <Icon name="pin" size={22} color={color.cedarDeep} />
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.activityText}>Where I play</Text>
          <Icon name="chevronRight" size={20} color={color.muted} />
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Help & Feedback" onPress={() => router.push("/help")}
                 style={({ pressed }) => [styles.card, styles.activity, pressed && { opacity: 0.85 }]} testID="profile-help">
        <Icon name="info" size={22} color={color.cedarDeep} />
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.activityText}>Help & Feedback</Text>
        <Icon name="chevronRight" size={20} color={color.muted} />
      </Pressable>
      {session.status === "signed-in" && safety.available ? (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.section}>Blocked players</Text>
          <BlockedPlayers />
        </>
      ) : null}
      {session.status === "signed-in" ? (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.section}>Delete account</Text>
          <DeleteAccount />
        </>
      ) : null}

      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.section}>About this app</Text>
      <View style={styles.card}>
        {build.map((row) =>
          row.value.length > 24 ? (
            // A long value (the update ID) gets its own line, kept on one line, so it can be read
            // and compared at a glance rather than broken with a character left over.
            <View key={row.label} style={styles.stacked}>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label}>{row.label}</Text>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.longValue} selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{row.value}</Text>
            </View>
          ) : (
            <View key={row.label} style={styles.row}>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label}>{row.label}</Text>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.rowValue} selectable>{row.value}</Text>
            </View>
          ),
        )}
      </View>
      {faultsAvailable() && (
        <>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.section}>Test tools (test builds only)</Text>
          <View style={styles.card} testID="test-tools">
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.value}>Lose the connection when reserving</Text>
            <Segmented
              options={(["off", "answer-lost", "request-lost"] as Fault[]).map((k) => ({ key: k, label: FAULT_LABEL[k] }))}
              value={fault}
              onChange={(k) => { setFault(k); }}
            />
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label}>
              Answer lost: the booking is really made, then the app acts as if the answer never arrived.{"\n"}
              Request lost: nothing is sent; the app acts as if the request never left.{"\n"}
              While on, the app cannot check bookings either. Closing the app turns this off.
            </Text>
            <Button
              label={reportSent ? "Test report sent" : "Send a test crash report"}
              variant="secondary"
              onPress={() => { sendTestReport(); setReportSent(true); }}
            />
            {E2E_PROBES && (
              <>
                {/* Emulator test builds only (M5 crash privacy): synthetic personal data, which must not reach Sentry. */}
                <Button
                  label={probeSent ? "Privacy probe sent" : "Send a privacy probe report"}
                  variant="secondary"
                  onPress={() => { sendPrivacyProbe(); setProbeSent(true); }}
                />
                <Button label="Crash the app (native test)" variant="secondary" onPress={crashNatively} />
              </>
            )}
          </View>
        </>
      )}
      {Updates.channel !== "production" && (
        <Pressable accessibilityRole="button" onPress={() => router.push("/design-preview")} style={styles.previewLink}>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.previewText}>Component preview (test builds only)</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  who: { flexDirection: "row", alignItems: "center", gap: space.md },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: color.night, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: color.red },
  initials: { fontFamily: font.display, fontSize: 20, color: color.onDark },
  name: { fontFamily: font.display, fontSize: 20, lineHeight: 25, color: color.ink },
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.md, paddingBottom: space.xxxl },
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.md },
  section: { ...text.label, color: color.muted, marginTop: space.md },
  label: { ...text.caption, color: color.muted },
  value: { ...text.body, color: color.ink },
  row: { flexDirection: "row", justifyContent: "space-between", gap: space.md },
  detailRows: { gap: 2 },
  missing: { ...text.body, color: color.warnInk },
  problem: { ...text.caption, color: color.danger },
  levelChips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  previewLink: { minHeight: 48, justifyContent: "center", alignItems: "center" },
  activity: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 8 },
  activityText: { ...text.label, flex: 1, color: color.ink, fontSize: 16 },
  badge: { minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: color.red },
  badgeText: { color: color.onDark, fontSize: 13, fontFamily: font.bold },
  previewText: { ...text.label, color: color.cedarDeep },
  stacked: { gap: 2 },
  longValue: { fontFamily: font.semibold, fontSize: 14, lineHeight: 19, color: color.ink, fontVariant: ["tabular-nums"] },
  rowValue: { ...text.label, color: color.ink, flexShrink: 1, textAlign: "right" },
});
