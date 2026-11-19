import { StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { Icon, type IconName } from "../Icon";
import { color, font, radius, space } from "../../lib/theme";
import type { Tone } from "../../lib/gameState";

/**
 * A status sentence at the top of the game screen. Warnings (court cancelled, request waiting) use
 * the soft amber surface, "You're in" the soft cedar one, never red (red is never a status). The
 * icon repeats the meaning, so it is never carried by colour alone; screen readers hear the words.
 */
const LOOK: Record<Tone, { bg: string; ink: string; icon: IconName; border: string }> = {
  warn: { bg: color.warnSoft, ink: color.warnInk, icon: "info", border: "#EBD9AE" },
  ok: { bg: color.cedarSoft, ink: color.cedarDeep, icon: "check", border: "#BFDFCB" },
  plain: { bg: color.card, ink: color.ink, icon: "info", border: color.line },
};

export function GameBanner({ tone, title, text, testID }: { tone: Tone; title?: string; text: string; testID?: string }) {
  const l = LOOK[tone];
  return (
    <View style={[styles.box, { backgroundColor: l.bg, borderColor: l.border }]} accessibilityRole={tone === "warn" ? "alert" : undefined} testID={testID}>
      <Icon name={l.icon} size={20} color={l.ink} strokeWidth={2.2} />
      <View style={styles.words}>
        {title ? <Text style={[styles.title, { color: l.ink }]}>{title}</Text> : null}
        <Text style={[styles.text, { color: l.ink }]}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg, borderRadius: radius.md, borderWidth: 1 },
  words: { flex: 1, gap: 2 },
  title: { fontFamily: font.bold, fontSize: 14, lineHeight: 18, letterSpacing: 0.6, textTransform: "uppercase" },
  text: { fontFamily: font.medium, fontSize: 15, lineHeight: 21 },
});
