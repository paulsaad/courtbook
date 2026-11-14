import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { Text } from "./Text";
import { color, font } from "../lib/theme";

/**
 * The CourtBook mark: the green cedar on a white tile edged in red top and bottom — a quiet nod to
 * the flag's red, white and green, not a copy of it — and the wordmark with "Book" in red.
 */
export function CedarTile({ size = 40 }: { size?: number }) {
  const band = Math.max(3, Math.round(size / 10));
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: size * 0.28, borderTopWidth: band, borderBottomWidth: band }]}>
      <Cedar size={size * 0.65} />
    </View>
  );
}

export function Cedar({ size = 26, tone = color.cedar }: { size?: number; tone?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 26 26" accessible={false}>
      <Path d="M13 3 C10 4.5 8 5.2 5 5.6 C8 6.6 18 6.6 21 5.6 C18 5.2 16 4.5 13 3Z" fill={tone} />
      <Path d="M13 7.4 C9.5 9 6.2 9.6 2.5 10 C7 11.4 19 11.4 23.5 10 C19.8 9.6 16.5 9 13 7.4Z" fill={tone} />
      <Path d="M13 12 C9.8 13.6 6 14.2 1.5 14.6 C6.5 16.2 19.5 16.2 24.5 14.6 C20 14.2 16.2 13.6 13 12Z" fill={tone} />
      <Rect x={12} y={15.8} width={2} height={6.5} rx={1} fill={color.cedarDeep} />
    </Svg>
  );
}

export function Wordmark({ size = 21, onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <Text accessibilityRole="header" accessibilityLabel="CourtBook" style={[styles.word, { fontSize: size, lineHeight: size * 1.15, color: onDark ? color.onDark : color.ink }]}>
      Court<Text style={[styles.word, { fontSize: size, color: onDark ? color.redOnDark : color.red }]}>Book</Text>
    </Text>
  );
}

export function Brand({ size = 40 }: { size?: number }) {
  return (
    <View style={styles.row}>
      <CedarTile size={size} />
      <Wordmark size={Math.round(size * 0.53)} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { backgroundColor: color.card, borderColor: color.red, alignItems: "center", justifyContent: "center", borderLeftWidth: 1, borderRightWidth: 1, borderLeftColor: color.line, borderRightColor: color.line },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  word: { fontFamily: font.displayHeavy, letterSpacing: -0.4 },
});
