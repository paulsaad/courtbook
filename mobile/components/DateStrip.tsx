import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { color, font, radius } from "../lib/theme";
import { haptic } from "../lib/haptics";

/** The booking window as a strip of days. The selected day carries the red line. */
export type Day = { key: string; weekday: string; day: string; a11y: string };

export function DateStrip({ days, selected, onSelect }: { days: Day[]; selected: string; onSelect: (key: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} accessibilityRole="tablist">
      {days.map((d) => {
        const on = d.key === selected;
        return (
          <Pressable
            key={d.key}
            accessibilityRole="tab"
            accessibilityLabel={d.a11y}
            accessibilityState={{ selected: on }}
            onPress={() => {
              haptic.select();
              onSelect(d.key);
            }}
            style={[styles.day, on && styles.dayOn]}
          >
            <Text style={[styles.weekday, on && styles.onText]}>{d.weekday}</Text>
            <Text style={[styles.num, on && styles.onText]}>{d.day}</Text>
            <View style={[styles.mark, on && styles.markOn]} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 4, paddingHorizontal: 20 },
  day: { width: 54, height: 60, borderRadius: radius.sm + 2, alignItems: "center", justifyContent: "center" },
  dayOn: { backgroundColor: color.ink },
  weekday: { fontFamily: font.regular, fontSize: 13, lineHeight: 16, color: color.muted },
  num: { fontFamily: font.score, fontSize: 22, lineHeight: 24, color: color.ink },
  onText: { color: color.onDark },
  mark: { position: "absolute", bottom: 5, width: 16, height: 3, borderRadius: 2 },
  markOn: { backgroundColor: color.red },
});
