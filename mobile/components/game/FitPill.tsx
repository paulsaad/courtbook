import { StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { color, font, radius } from "../../lib/theme";

/** Level fit ("You're Level 5 · fits"), with an icon and words — never colour alone. */
export function FitPill({ text, tone }: { text: string; tone: "ok" | "warn" | "muted" }) {
  const bg = tone === "ok" ? color.cedarSoft : tone === "warn" ? color.warnSoft : "transparent";
  const ink = tone === "ok" ? color.cedarDeep : tone === "warn" ? color.warnInk : color.muted;
  return (
    <View style={[styles.pill, { backgroundColor: bg }, tone === "muted" && styles.plain]}>
      <Icon name={tone === "ok" ? "check" : tone === "warn" ? "info" : "person"} size={16} color={ink} strokeWidth={2.2} />
      <Text style={[styles.text, { color: ink }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.sm, maxWidth: "100%" },
  plain: { paddingHorizontal: 0 },
  text: { fontFamily: font.semibold, fontSize: 14, lineHeight: 18, flexShrink: 1 },
});
