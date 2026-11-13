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
  track: { flexDirection: "row", padding: 4, gap: 4, borderRadius: 14, backgroundColor: "#E8E3D8" },
  seg: { flex: 1, minHeight: 44, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  segOn: { backgroundColor: color.card },
  text: { fontFamily: font.semibold, fontSize: 15, color: color.muted },
  textOn: { fontFamily: font.bold, color: color.ink },
});
