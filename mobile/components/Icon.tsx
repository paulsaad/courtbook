import Svg, { Circle, Line, Path, Rect } from "react-native-svg";
import { color as palette } from "../lib/theme";

/**
 * CourtBook's own line icons, drawn on a 24-unit grid with the same stroke language as the court
 * marks. Decorative by default: the control that holds an icon carries the accessible label.
 */
export type IconName =
  | "home" | "court" | "calendar" | "person" | "bell" | "pin" | "chevronRight" | "chevronDown"
  | "back" | "close" | "check" | "plus" | "chat" | "clock" | "players" | "coach";

export function Icon({ name, size = 24, color = palette.ink, strokeWidth = 1.8 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const p = { fill: "none", stroke: color, strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      {name === "home" && <Path {...p} d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" />}
      {name === "court" && (<><Rect {...p} x={4} y={3} width={16} height={18} rx={1.5} /><Line {...p} x1={4} y1={12} x2={20} y2={12} /><Line {...p} x1={12} y1={7} x2={12} y2={17} /></>)}
      {name === "calendar" && (<><Rect {...p} x={3.5} y={5} width={17} height={15.5} rx={2} /><Path {...p} d="M3.5 10h17M8 3v4M16 3v4" /></>)}
      {name === "person" && (<><Circle {...p} cx={12} cy={8.5} r={4} /><Path {...p} d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6" /></>)}
      {name === "bell" && (<><Path {...p} d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" /><Path {...p} d="M10 20a2 2 0 0 0 4 0" /></>)}
      {name === "pin" && (<><Path {...p} d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21Z" /><Circle {...p} cx={12} cy={9.5} r={2.5} /></>)}
      {name === "chevronRight" && <Path {...p} d="m9 6 6 6-6 6" />}
      {name === "chevronDown" && <Path {...p} d="m6 9 6 6 6-6" />}
      {name === "back" && <Path {...p} d="m15 6-6 6 6 6" />}
      {name === "close" && <Path {...p} d="M6 6l12 12M18 6 6 18" />}
      {name === "check" && <Path {...p} d="m5 12.5 4.5 4.5L19 7.5" />}
      {name === "plus" && <Path {...p} d="M12 5v14M5 12h14" />}
      {name === "chat" && <Path {...p} d="M4 5h16v11H9l-5 4z" />}
      {name === "clock" && (<><Circle {...p} cx={12} cy={12} r={8.5} /><Path {...p} d="M12 7.5V12l3 2" /></>)}
      {name === "players" && (<><Circle {...p} cx={8} cy={8} r={3} /><Circle {...p} cx={16.5} cy={8} r={3} /><Path {...p} d="M2.5 19c.6-3 2.7-4.6 5.5-4.6s4.9 1.6 5.5 4.6M13.5 14.6c.9-.2 2-.2 3-.2 2.8 0 4.9 1.6 5.5 4.6" /></>)}
      {name === "coach" && (<><Circle {...p} cx={12} cy={7.5} r={3.5} /><Path {...p} d="M5 21c.8-4 3.5-6.5 7-6.5s6.2 2.5 7 6.5M12 14.5v3" /></>)}
    </Svg>
  );
}
