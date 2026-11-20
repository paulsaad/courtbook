import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { FitPill } from "./FitPill";
import { SlotDots } from "./SlotDots";
import { boardCard, NO_COURT } from "../../lib/gameFormat";
import { sportName } from "../../lib/days";
import { color, font, radius, space } from "../../lib/theme";
import type { OpenGameRow } from "../../lib/gameTypes";

/**
 * One game on the Find a game board (approved Stitch export 14, "time first"). The whole card is one
 * button that opens the game; "Join" / "Ask to join" is a label saying how joining works, not an
 * action. Screen readers hear one sentence (boardCard's a11y). Everything shown comes from the row
 * open_matches returned — nothing is computed about permissions here.
 */
export function GameCard({ row, onPress, now, label: forced }: { row: OpenGameRow; onPress: () => void; now?: Date; label?: string }) {
  const c = boardCard(row, now);
  const noCourt = c.court === NO_COURT;
  const label = forced ?? (c.joined ? "Joined" : c.join);
  const green = !forced && row.join_mode === "open" && !c.joined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={forced ? `${c.a11y}, ${forced}` : c.a11y}
      accessibilityHint="Opens the game"
      onPress={onPress}
      testID={`game-card-${row.match_id}`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.top}>
        <View style={styles.when}>
          <View style={styles.eyebrowRow}>
            <View style={styles.tick} />
            <Text variant="eyebrow" style={styles.eyebrow}>{`${sportName(row.sport)} · ${c.when.day}`}</Text>
          </View>
          <Text style={styles.time}>{c.when.time}</Text>
        </View>
        <View style={[styles.mode, green ? styles.modeOpen : null]}>
          <Text style={[styles.modeText, green ? styles.modeTextOpen : null]}>{label}</Text>
        </View>
      </View>

      <View style={{ gap: 2 }}>
        <Text style={styles.club}>{row.town ? `${row.club_name} · ${row.town}` : row.club_name}</Text>
        <Text variant="secondary">{noCourt ? c.level : `${c.court} · ${c.level}`}</Text>
        {noCourt ? <Text variant="secondary" testID="no-court">{NO_COURT}</Text> : null}
      </View>

      <FitPill text={c.fit.text} tone={c.fit.tone} />

      <View style={styles.panel}>
        <SlotDots filled={c.spots.filled} capacity={c.spots.capacity} text={c.spots.text} />
        {c.organiser || c.note ? (
          <View style={styles.organiser}>
            <Icon name="chat" size={18} color={color.muted} />
            <Text style={styles.organiserText}>
              {c.organiser ? <Text style={styles.organiserName}>{c.organiser}</Text> : null}
              {c.organiser && c.note ? " · " : null}
              {c.note ?? null}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.md },
  pressed: { backgroundColor: "#FBF9F4" },
  top: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", columnGap: space.sm, rowGap: space.xs },
  when: { flexShrink: 1, minWidth: 160 },
  eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  tick: { width: 2, height: 14, borderRadius: 1, backgroundColor: color.red },
  eyebrow: { flexShrink: 1 },
  time: { fontFamily: font.score, fontSize: 30, lineHeight: 34, color: color.ink },
  mode: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: "#EEEAE1", borderWidth: 1, borderColor: color.line },
  modeOpen: { backgroundColor: color.cedarSoft, borderColor: "#BFDFCB" },
  modeText: { fontFamily: font.semibold, fontSize: 13, lineHeight: 17, color: color.muted },
  modeTextOpen: { color: color.cedarDeep },
  club: { fontFamily: font.display, fontSize: 18, lineHeight: 23, color: color.ink },
  panel: { backgroundColor: "#F7F4ED", borderRadius: radius.md, padding: space.md, gap: space.sm },
  organiser: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  organiserText: { flex: 1, fontFamily: font.regular, fontSize: 15, lineHeight: 20, color: color.ink },
  organiserName: { fontFamily: font.semibold },
});
