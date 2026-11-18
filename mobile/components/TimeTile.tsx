import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Svg, { Defs, Line, Pattern, Rect } from "react-native-svg";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { color, font, radius } from "../lib/theme";
import { haptic } from "../lib/haptics";

/**
 * One start time on the availability grid. Four states, each told apart by words and shape as
 * well as colour (approved design): free (outline, "3 courts"), limited (amber, "1 court free"),
 * selected (filled, tick, "selected"), not free (hatched, struck through, "Not free", not pressable).
 * "Not free" rather than "Booked": the availability data cannot tell a booking from the club being
 * closed, and a screen must not assert what the system does not know.
 *
 * Above SELECTED_WORD_MAX_SCALE the word "selected" no longer fits a tile line on a 360 dp phone and
 * Android breaks it mid-word ("se/lected", F4). There the tile drops the word: the fill and the tick
 * still show it, screen readers still hear "selected", and the panel below names the chosen time.
 *
 * The counts describe what the last successful read returned. Nothing here promises the slot:
 * the server decides when the player reserves.
 */
export type TileState = "free" | "limited" | "selected" | "booked";

export function tileState(freeCourts: number, selected: boolean): TileState {
  if (freeCourts <= 0) return "booked";
  if (selected) return "selected";
  return freeCourts === 1 ? "limited" : "free";
}

/** Largest text scale at which "selected" still fits a tile line on a 360 dp phone (checked on the emulator). */
export const SELECTED_WORD_MAX_SCALE = 1.3;

/** `price` is optional: the exact total comes from the server quote once a time is chosen. */
export function tileLabel(state: TileState, price: string | null, freeCourts: number, fontScale = 1): string {
  const p = price ? `${price} · ` : "";
  switch (state) {
    case "booked": return "Not free";
    case "selected": return fontScale > SELECTED_WORD_MAX_SCALE ? (price ?? "") : `${p}selected`;
    case "limited": return `${p}1 court free`;
    case "free": return `${p}${freeCourts} courts`;
  }
}

export function tileAccessibilityLabel(time: string, state: TileState, price: string | null, freeCourts: number): string {
  if (state === "booked") return `${time}, not free`;
  const courts = freeCourts === 1 ? "1 court free" : `${freeCourts} courts free`;
  return `${time}, ${price ? `${price}, ` : ""}${courts}${state === "selected" ? ", selected" : ""}`;
}

type Props = { time: string; price?: string | null; freeCourts: number; selected: boolean; onPress: () => void; disabled?: boolean };

/** `disabled` locks the grid while a reservation is in flight; the selected time stays readable. */
export function TimeTile({ time, price = null, freeCourts, selected, onPress, disabled = false }: Props) {
  const state = tileState(freeCourts, selected);
  const s = look[state];
  const { fontScale } = useWindowDimensions();
  return (
    <Pressable
      testID={state === "booked" ? `time-taken-${time}` : `time-${time}`}
      accessibilityRole="button"
      accessibilityLabel={tileAccessibilityLabel(time, state, price, freeCourts)}
      accessibilityState={{ selected: state === "selected", disabled: state === "booked" || disabled }}
      disabled={state === "booked" || disabled}
      onPress={() => {
        haptic.select();
        onPress();
      }}
      style={({ pressed }) => [styles.tile, s.tile, pressed && state !== "booked" && styles.pressed, disabled && state !== "selected" && state !== "booked" && { opacity: 0.5 }]}
    >
      {state === "booked" && <Hatch />}
      <View style={styles.top}>
        {/* At the largest text sizes on a narrow phone, shrink rather than break "08:00" over two lines. */}
        <Text style={[styles.time, s.time]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{time}</Text>
        {state === "selected" && <Icon name="check" size={18} color={color.onDark} strokeWidth={3} />}
      </View>
      <Text style={[styles.label, s.label]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{tileLabel(state, price, freeCourts, fontScale)}</Text>
    </Pressable>
  );
}

function Hatch() {
  return (
    <Svg style={StyleSheet.absoluteFill} accessible={false}>
      <Defs>
        <Pattern id="hatch" width={8} height={8} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <Line x1={0} y1={0} x2={0} y2={8} stroke="#E2DCCF" strokeWidth={4} />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#hatch)" />
    </Svg>
  );
}

const look = {
  free: { tile: { borderWidth: 1.5, borderColor: color.cedar, backgroundColor: color.card }, time: { color: color.ink }, label: { color: color.cedarDeep } },
  limited: { tile: { borderWidth: 1.5, borderColor: color.warnInk, backgroundColor: color.warnSoft }, time: { color: color.ink }, label: { color: color.warnInk } },
  selected: { tile: { borderWidth: 2, borderColor: color.night, backgroundColor: color.cedar }, time: { color: color.onDark }, label: { color: color.onDark } },
  booked: { tile: { borderWidth: 1, borderColor: color.line, backgroundColor: color.ground }, time: { color: color.booked, textDecorationLine: "line-through" as const }, label: { color: color.booked } },
};

const styles = StyleSheet.create({
  tile: { minHeight: 72, borderRadius: radius.md, paddingHorizontal: 11, paddingVertical: 9, justifyContent: "space-between", overflow: "hidden", flex: 1 },
  pressed: { opacity: 0.85 },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  time: { fontFamily: font.score, fontSize: 26, lineHeight: 28, flexShrink: 1 },
  label: { fontFamily: font.semibold, fontSize: 13, lineHeight: 17 },
});
