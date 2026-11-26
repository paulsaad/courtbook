/**
 * Words for the database's codes on player screens: "padel" → "Padel", "beginner" → "Beginner",
 * "table_tennis" → "Table tennis". Sport and level codes are lower-case words joined by "_", so this is their
 * display name — the same rule as the app's sportName (and the sports-catalogue draft #66). Empty stays empty.
 */
export function codeLabel(code: string | null | undefined): string {
  if (!code) return "";
  if (code === "other") return "Other";
  const words = code.replace(/_/g, " ");
  return words[0].toUpperCase() + words.slice(1);
}

/** "padel, tennis" → "Padel, Tennis". */
export function codeList(codes: readonly string[] | null | undefined): string {
  return (codes ?? []).map(codeLabel).join(", ");
}

/** Home's heading over the next item: a court booking is a booking, a match is a game. */
export function nextHeading(kind: string): string {
  return kind === "booking" ? "Your next booking" : "Your next game";
}
