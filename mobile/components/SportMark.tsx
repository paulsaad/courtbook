import Svg, { Circle, Line, Rect } from "react-native-svg";
import { color as palette } from "../lib/theme";

/** Each sport drawn from its own court plan. Unknown sports get the "other" mark, never nothing. */
export const SPORTS = ["padel", "tennis", "football", "basketball", "volleyball", "squash", "badminton", "other"] as const;
export type Sport = (typeof SPORTS)[number];

export function SportMark({ sport, size = 28, color = palette.cedar }: { sport: string; size?: number; color?: string }) {
  const p = { fill: "none", stroke: color, strokeWidth: 1.5 };
  const net = { ...p, strokeWidth: 2.3 };
  const s = (SPORTS as readonly string[]).includes(sport) ? sport : "other";
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      {s === "padel" && (<><Rect {...p} x={4} y={2.5} width={16} height={19} rx={1} /><Line {...net} x1={4} y1={12} x2={20} y2={12} /><Line {...p} x1={4} y1={7.5} x2={20} y2={7.5} /><Line {...p} x1={4} y1={16.5} x2={20} y2={16.5} /><Line {...p} x1={12} y1={7.5} x2={12} y2={16.5} /></>)}
      {s === "tennis" && (<><Rect {...p} x={3} y={2.5} width={18} height={19} rx={1} /><Line {...p} x1={5.5} y1={2.5} x2={5.5} y2={21.5} /><Line {...p} x1={18.5} y1={2.5} x2={18.5} y2={21.5} /><Line {...net} x1={3} y1={12} x2={21} y2={12} /><Line {...p} x1={5.5} y1={7} x2={18.5} y2={7} /><Line {...p} x1={5.5} y1={17} x2={18.5} y2={17} /><Line {...p} x1={12} y1={7} x2={12} y2={17} /></>)}
      {s === "football" && (<><Rect {...p} x={3} y={2.5} width={18} height={19} rx={1} /><Line {...p} x1={3} y1={12} x2={21} y2={12} /><Circle {...p} cx={12} cy={12} r={3} /><Rect {...p} x={8} y={2.5} width={8} height={3.5} /><Rect {...p} x={8} y={18} width={8} height={3.5} /></>)}
      {s === "basketball" && (<><Rect {...p} x={3} y={2.5} width={18} height={19} rx={1} /><Line {...p} x1={3} y1={12} x2={21} y2={12} /><Circle {...p} cx={12} cy={12} r={2.5} /><Rect {...p} x={9} y={2.5} width={6} height={5} /><Rect {...p} x={9} y={16.5} width={6} height={5} /></>)}
      {s === "volleyball" && (<><Rect {...p} x={4} y={3} width={16} height={18} rx={1} /><Line {...net} x1={4} y1={12} x2={20} y2={12} /><Line {...p} x1={4} y1={9} x2={20} y2={9} /><Line {...p} x1={4} y1={15} x2={20} y2={15} /></>)}
      {s === "squash" && (<><Rect {...p} x={4} y={2.5} width={16} height={19} rx={1} /><Line {...net} x1={4} y1={4.5} x2={20} y2={4.5} /><Line {...p} x1={4} y1={12.5} x2={20} y2={12.5} /><Line {...p} x1={12} y1={12.5} x2={12} y2={21.5} /><Rect {...p} x={4} y={12.5} width={4} height={4} /><Rect {...p} x={16} y={12.5} width={4} height={4} /></>)}
      {s === "badminton" && (<><Rect {...p} x={4} y={2.5} width={16} height={19} rx={1} /><Line {...net} x1={4} y1={12} x2={20} y2={12} /><Line {...p} x1={4} y1={9.5} x2={20} y2={9.5} /><Line {...p} x1={4} y1={14.5} x2={20} y2={14.5} /><Line {...p} x1={12} y1={2.5} x2={12} y2={9.5} /><Line {...p} x1={12} y1={14.5} x2={12} y2={21.5} /></>)}
      {s === "other" && (<><Rect {...p} x={4} y={2.5} width={16} height={19} rx={1} /><Circle cx={12} cy={12} r={1.4} fill={color} /></>)}
    </Svg>
  );
}
