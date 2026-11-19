import { StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { color, font } from "../../lib/theme";

/**
 * The places in a game: filled places are cedar dots, open places red dashed circles (the brand
 * accent), and the count is said in words beside them, so the meaning never rests on colour. No
 * names or initials: who is playing is shown only where the database returns names (members).
 * `paused`: joining is paused (court booking cancelled) — open places are drawn muted, not red.
 */
export function SlotDots({ filled, capacity, size = 14, paused = false, text }: { filled: number; capacity: number; size?: number; paused?: boolean; text: string }) {
  const open = Math.max(0, capacity - filled);
  const dots = Math.min(capacity, 12); // a 30-player game shows 12 dots and the words carry the count
  const filledDots = Math.min(filled, dots);
  return (
    <View style={styles.row} accessible accessibilityLabel={`${filled} of ${capacity} places filled, ${text}`}>
      <View style={styles.dots}>
        {Array.from({ length: dots }).map((_, i) => (
          <View key={i} style={[{ width: size, height: size, borderRadius: size / 2 }, i < filledDots ? styles.filled : paused ? styles.paused : styles.open]} />
        ))}
      </View>
      <Text style={[styles.count, open === 0 && styles.full]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 12, rowGap: 6 },
  dots: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  filled: { backgroundColor: color.cedar },
  open: { borderWidth: 1.5, borderStyle: "dashed", borderColor: color.red, backgroundColor: color.card },
  paused: { borderWidth: 1.5, borderStyle: "dashed", borderColor: color.emptySlot, backgroundColor: color.card },
  count: { fontFamily: font.score, fontSize: 20, lineHeight: 24, color: color.ink },
  full: { color: color.muted },
});
