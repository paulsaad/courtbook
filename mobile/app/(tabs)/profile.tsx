import { useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import * as Updates from "expo-updates";
import { supabase } from "../../lib/supabase";
import { useSession } from "../../lib/session";
import { currentBuild } from "../../lib/buildInfo";
import { initials, useProfileName } from "../../lib/profile";
import { installedVariant as appVariant } from "../../lib/appIdentity";
import { Button } from "../../components/Button";
import { Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { Segmented } from "../../components/Segmented";
import { Icon } from "../../components/Icon";
import { badgeText, unreadCount, useActivity } from "../../lib/activity";
import { FAULT_LABEL, currentFault, faultsAvailable, setFault, subscribeFault, type Fault } from "../../lib/testFaults";
import { sendTestReport } from "../../lib/crash";
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
  const name = useProfileName(session.status === "signed-in" ? session.session.user.id : null);
  const email = session.status === "signed-in" ? session.session.user.email ?? null : null;
  const shownName = name.data?.trim() || null;
  const safety = useSafety(session.status === "signed-in");

  async function signOut() {
    setBusy(true);
    // The session provider empties the cache on every sign-out, however it happens.
    await supabase.auth.signOut();
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
          <View style={styles.who}>
            <View style={styles.avatar} accessible={false}>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.initials}>{initials(shownName ?? email)}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.name} numberOfLines={2}>{shownName ?? "Signed in"}</Text>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.label} selectable numberOfLines={1}>{email ?? "your account"}</Text>
            </View>
          </View>
          <Button label="Sign out" variant="secondary" busy={busy} onPress={signOut} />
        </View>
      )}
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
