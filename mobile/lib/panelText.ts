/**
 * Words for the booking panel that must never break inside a unit (F5, 18 Nov: at large text on a
 * 360 dp phone "08:00–09:30" broke as "08:00–09:3 / 0" and "1 h 30" as "1 h / 30"). Lines may break
 * only after a " · " separator. Uses a no-break space inside units and word joiners around the dash;
 * both are invisible and screen readers read the text as usual.
 */
const NBSP = " ";
const WJ = "⁠";

/** "1 h 30" → one unbreakable unit. */
export function unit(s: string): string {
  return s.replace(/ /g, NBSP);
}

/** "08:00–09:30", unbreakable. */
export function timeRange(start: string, end: string): string {
  return `${start}${WJ}–${WJ}${end}`;
}

/** Parts joined by " · ", each kept whole; a line can break only after a dot. */
export function joinParts(parts: string[]): string {
  return parts.map(unit).join(`${NBSP}· `);
}
