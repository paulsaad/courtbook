import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { color, font } from "../lib/theme";

/** Two or three mutually exclusive views of one list (Courts | Games). */
export function Segmented<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(o.key)} style={[styles.seg, on && styles.segOn]}>
            <Text style={[styles.text, on && styles.textOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // Approved Club Info handoff §4A: 12 pt track, 10 pt white thumb with a hairline, SemiBold ink when
  // selected, Regular muted otherwise. The track keeps its darker limestone so it stays visible on the
  // limestone page.
  track: { flexDirection: "row", padding: 4, gap: 4, borderRadius: 12, backgroundColor: "#E8E3D8" },
  seg: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "transparent" },
  segOn: { backgroundColor: color.card, borderColor: color.line },
  text: { fontFamily: font.regular, fontSize: 15, color: color.muted },
  textOn: { fontFamily: font.semibold, color: color.ink },
});
