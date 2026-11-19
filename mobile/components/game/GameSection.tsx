import { StyleSheet, View } from "react-native";
import type { ReactNode } from "react";
import { Text } from "../Text";
import { color, radius, space } from "../../lib/theme";

/**
 * One white section of the game screens (approved Stitch exports 26–30): an uppercase heading with
 * the short red court-line tick, an optional note on the right, then the content. The heading and
 * note wrap at large text sizes instead of overlapping.
 */
export function GameSection({ title, note, children, testID }: { title: string; note?: string | null; children: ReactNode; testID?: string }) {
  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.head}>
        <View style={styles.titleRow}>
          <View style={styles.tick} />
          <Text variant="eyebrow" style={styles.title} accessibilityRole="header">{title}</Text>
        </View>
        {note ? <Text variant="secondary" style={styles.note}>{note}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.md },
  head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: space.md, rowGap: space.xs },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1 },
  tick: { width: 3, height: 16, borderRadius: 2, backgroundColor: color.red },
  title: { color: color.ink, flexShrink: 1 },
  note: { flexShrink: 1 },
});
