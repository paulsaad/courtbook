/**
 * Words for the database's codes on player screens: "padel" → "Padel", "beginner" → "Beginner".
 * Sport and level codes are lower-case words, so a capital first letter is their display name (the same
 * rule as the app's sportName). Unknown or empty codes are shown as they are.
 */
export function codeLabel(code: string | null | undefined): string {
  if (!code) return "";
  return code === "other" ? "Other" : code[0].toUpperCase() + code.slice(1);
}

/** "padel, tennis" → "Padel, Tennis". */
export function codeList(codes: readonly string[] | null | undefined): string {
  return (codes ?? []).map(codeLabel).join(", ");
}

/** Home's heading over the next item: a court booking is a booking, a match is a game. */
export function nextHeading(kind: string): string {
  return kind === "booking" ? "Your next booking" : "Your next game";
}
