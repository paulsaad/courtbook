import { Pressable, StyleSheet, type ViewStyle } from "react-native";
import type { ReactNode } from "react";
import { Text } from "./Text";
import { color, font, TOUCH } from "../lib/theme";
import { haptic } from "../lib/haptics";

/** A filter or choice pill. `selected` is announced to screen readers, not only drawn. */
export function Chip({ label, selected = false, onPress, icon, style }: { label: string; selected?: boolean; onPress: () => void; icon?: ReactNode; style?: ViewStyle }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      style={({ pressed }) => [styles.chip, selected ? styles.on : styles.off, pressed && { opacity: 0.85 }, style]}
    >
      {icon}
      <Text style={[styles.text, selected && styles.textOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { minHeight: TOUCH - 4, paddingHorizontal: 16, borderRadius: 999, flexDirection: "row", alignItems: "center", gap: 6 },
  on: { backgroundColor: color.ink },
  off: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line },
  text: { fontFamily: font.semibold, fontSize: 15, color: color.ink },
  textOn: { color: color.onDark },
});
