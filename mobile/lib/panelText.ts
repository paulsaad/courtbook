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

/** The line under the slot at a club where only CourtBook's booking fee is paid in the app (Model 2). The hold length is
 *  the club's own (clubs.hold_minutes, the same value hold_slot uses and the website shows); unknown → no number. */
export function feeOnlineNote(fee: string, holdMinutes: number | null | undefined): string {
  const held = holdMinutes ? `the court is held for ${holdMinutes} ${holdMinutes === 1 ? "minute" : "minutes"} while you pay` : "the court is held for a few minutes while you pay";
  return `Court price paid at the club. CourtBook booking fee ${fee}, paid online to confirm — ${held}. The fee is not refunded if you cancel; it is refunded if the club cancels or your booking cannot be confirmed.`;
}
