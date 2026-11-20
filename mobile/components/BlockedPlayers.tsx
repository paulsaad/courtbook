import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "./Button";
import { afterBlockChange, unblockPlayer, useBlockedPlayers } from "../lib/safety";
import { color, radius, space, text, MAX_FONT_SCALE } from "../lib/theme";

/**
 * Profile → Blocked players (M3-S; UX §4.6 "Block": "You can unblock them in Profile"). Only the
 * blocker's own list (my_blocked_players). Unblocking asks first, then the board and games refresh.
 */
export function BlockedPlayers() {
  const q = useBlockedPlayers(true);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const unblock = (id: string, name: string | null) => Alert.alert(`Unblock ${name ?? "this player"}?`,
    "You'll see their messages and games again, and they can ask to join yours. They aren't told.", [
      { text: "Cancel", style: "cancel" },
      { text: "Unblock", onPress: async () => {
        setBusy(id); setProblem(null);
        const f = await unblockPlayer(id);
        setBusy(null);
        if (f) setProblem(f.message); else afterBlockChange(qc);
      } },
    ]);

  return (
    <View style={styles.card} testID="blocked-players">
      {q.isLoading ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.muted}>Loading…</Text>
        : q.isError ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.muted}>Couldn't load the list. Pull down to try again later.</Text>
        : (q.data ?? []).length === 0 ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.muted}>You haven't blocked anyone.</Text>
        : (q.data ?? []).map((b) => (
          <View key={b.profile_id} style={styles.row}>
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.name} numberOfLines={1}>{b.name ?? "Player"}</Text>
            <Button label="Unblock" variant="secondary" busy={busy === b.profile_id} onPress={() => unblock(b.profile_id, b.name)} testID={`unblock-${b.profile_id}`} />
          </View>
        ))}
      {problem ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.problem} accessibilityRole="alert">{problem}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.md },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  name: { ...text.label, color: color.ink, flex: 1 },
  muted: { ...text.caption, color: color.muted },
  problem: { ...text.caption, color: color.danger },
});
