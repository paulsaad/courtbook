import { useState } from "react";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Text } from "../components/Text";
import { Icon, type IconName } from "../components/Icon";
import { Loading } from "../components/StateView";
import { FeedbackSheet, ReportSheet } from "../components/game/SafetySheets";
import { useSession } from "../lib/session";
import { currentBuild } from "../lib/buildInfo";
import {
  afterBlockChange, blockPlayer, CONTACT_EMAIL, feedbackContext, reportContent, sendFeedback, useRecentPlayers, useSafety,
  type FeedbackKind, type RecentPlayer,
} from "../lib/safety";
import { color, radius, space, TOUCH } from "../lib/theme";

/**
 * Profile → Help & Feedback. An app problem or a suggestion goes to the CourtBook team only
 * (send_feedback, read through Admin → Reports). "Report player behaviour" picks a player from my games
 * and uses the same report as everywhere else (report_content). The contact address is always shown;
 * the three options appear where the database has them (0074, staging).
 */
export default function Help() {
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const safety = useSafety(signedIn);
  const qc = useQueryClient();
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [picking, setPicking] = useState(false);
  const [reporting, setReporting] = useState<RecentPlayer | null>(null);
  const players = useRecentPlayers(picking && safety.available);
  const context = feedbackContext(Platform.OS, currentBuild());

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Help & Feedback" }} />
      {signedIn && safety.available ? (
        <View style={styles.card}>
          <Row icon="info" title="Report an app problem" sub="Something didn't work as it should" onPress={() => setKind("app_problem")} testID="help-problem" />
          <Row icon="send" title="Suggest an improvement" sub="An idea for CourtBook" onPress={() => setKind("suggestion")} testID="help-suggest" />
          <Row icon="person" title="Report player behaviour" sub="Someone from one of your games" onPress={() => setPicking(true)} testID="help-report-player" last />
        </View>
      ) : null}

      {picking ? (
        <View style={styles.card} testID="recent-players">
          <Text variant="label">Who do you want to report?</Text>
          {players.isLoading ? <Loading label="Loading players" />
            : players.isError ? <Text variant="secondary">Couldn't load your recent players. Try again later.</Text>
            : (players.data ?? []).length === 0 ? <Text variant="secondary">No players from your recent games.</Text>
            : (players.data ?? []).map((p) => (
              <Pressable key={p.profile_id} accessibilityRole="button" accessibilityLabel={`Report ${p.name ?? "player"}`} onPress={() => setReporting(p)}
                         style={({ pressed }) => [styles.player, pressed && { opacity: 0.7 }]} testID={`recent-${p.profile_id}`}>
                <Text variant="strong" style={{ flex: 1 }} numberOfLines={1}>{p.name ?? "Player"}</Text>
                <Icon name="chevronRight" size={20} color={color.muted} />
              </Pressable>
            ))}
          <Text variant="caption">To report a message or a game, use Report in that chat or on the game.</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text variant="label">Contact us</Text>
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(`mailto:${CONTACT_EMAIL}`)} style={styles.mail}>
          <Text style={styles.mailText} selectable>{CONTACT_EMAIL}</Text>
        </Pressable>
        {!signedIn ? <Text variant="caption">Sign in to send a problem or a suggestion from the app.</Text> : null}
        <Text variant="caption">If anyone is in danger, contact the police or emergency services now.</Text>
      </View>

      <FeedbackSheet kind={kind} onClose={() => setKind(null)}
                     onSend={async (k, text) => (await sendFeedback(k, text, context))?.message ?? null} />
      <ReportSheet visible={!!reporting} what={reporting?.name ?? "player"} onClose={() => setReporting(null)}
                   onSend={async (reason, note) => (await reportContent("player", reporting!.profile_id, reason, note))?.message ?? null}
                   onBlock={reporting ? async () => { const f = await blockPlayer(reporting.profile_id); if (!f) afterBlockChange(qc); } : undefined} />
    </ScrollView>
  );
}

function Row({ icon, title, sub, onPress, testID, last }: { icon: IconName; title: string; sub: string; onPress: () => void; testID: string; last?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} testID={testID}
               style={({ pressed }) => [styles.row, !last && styles.rowLine, pressed && { opacity: 0.7 }]}>
      <Icon name={icon} size={22} color={color.cedarDeep} />
      <View style={{ flex: 1 }}>
        <Text variant="strong">{title}</Text>
        <Text variant="caption">{sub}</Text>
      </View>
      <Icon name="chevronRight" size={20} color={color.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.md, paddingBottom: space.xxxl },
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 8 },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.line, paddingBottom: space.md },
  player: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH },
  mail: { minHeight: TOUCH, justifyContent: "center" },
  mailText: { color: color.cedarDeep, fontSize: 16, textDecorationLine: "underline" },
});
