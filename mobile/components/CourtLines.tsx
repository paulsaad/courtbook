import { StyleSheet } from "react-native";
import Svg, { Line, Rect } from "react-native-svg";

/**
 * The decorative court marking on dark surfaces. Purely visual; hidden from screen readers.
 * `inline` lays it out as an ordinary element (it takes its own space, so nothing can sit on top of
 * it); otherwise it floats in a corner — only where no text can reach it.
 */
export function CourtLines({ opacity = 0.1, width = 220, height = 180, right = -40, top = -20, inline = false }: { opacity?: number; width?: number; height?: number; right?: number; top?: number; inline?: boolean }) {
  const p = { fill: "none", stroke: "#FFFFFF", strokeOpacity: opacity, strokeWidth: inline ? 4 : 1.5 };
  return (
    <Svg width={width} height={height} viewBox="0 0 220 180" style={inline ? undefined : [StyleSheet.absoluteFill, { left: undefined, bottom: undefined, right, top }]} accessible={false} pointerEvents="none">
      <Rect {...p} x={20} y={10} width={180} height={160} />
      <Line {...p} x1={20} y1={90} x2={200} y2={90} strokeWidth={3} />
      <Line {...p} x1={20} y1={45} x2={200} y2={45} />
      <Line {...p} x1={20} y1={135} x2={200} y2={135} />
      <Line {...p} x1={110} y1={45} x2={110} y2={135} />
    </Svg>
  );
}
