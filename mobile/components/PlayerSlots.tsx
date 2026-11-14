import { StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { color, font } from "../lib/theme";

/**
 * Who is in a game and how many places are open. Players are green initials; open places are red
 * dashed circles; the count is said in words ("2 spots left"), so it is never colour alone.
 */
export function PlayerSlots({ players, capacity, size = 26 }: { players: string[]; capacity: number; size?: number }) {
  const open = Math.max(0, capacity - players.length);
  const label = open === 0 ? `Full · ${capacity} of ${capacity}` : `${players.length} of ${capacity} players, ${open} ${open === 1 ? "spot" : "spots"} left`;
  return (
    <View style={styles.row} accessible accessibilityLabel={label}>
      {players.map((p, i) => (
        <View key={`${p}-${i}`} style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: i % 2 ? color.cedarDeep : color.cedar }]}>
          <Text style={styles.initials}>{p}</Text>
        </View>
      ))}
      {Array.from({ length: open }).map((_, i) => (
        <View key={`open-${i}`} style={[styles.dot, styles.open, { width: size - 2, height: size - 2, borderRadius: size / 2 }]} />
      ))}
      <Text style={[styles.count, open === 0 && styles.full]}>{open === 0 ? "Full" : `${open} ${open === 1 ? "spot" : "spots"} left`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { alignItems: "center", justifyContent: "center" },
  open: { borderWidth: 1.5, borderStyle: "dashed", borderColor: color.red },
  initials: { fontFamily: font.bold, fontSize: 11, color: color.onDark },
  count: { marginLeft: 6, fontFamily: font.bold, fontSize: 14, color: color.red },
  full: { color: color.muted },
});
