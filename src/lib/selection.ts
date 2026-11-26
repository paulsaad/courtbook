/**
 * What one Reserve tap books: a court, a start instant and a length. The app keys its reservations the same way
 * (mobile/app/club/[id].tsx `selKey`, review of #70): two taps book the same thing only if their keys are equal.
 */
export const selectionKey = (courtId: string, start: Date, minutes: number) => `${courtId}|${start.toISOString()}|${minutes}`;

/**
 * The retry token belongs to one selection. Trying that exact selection again reuses it, so an attempt whose answer
 * was lost can never take a second court. Any other selection gets a new token: book_at_desk refuses a token reused
 * for another court or time (`token_reused`, 0053), so carrying the old one over would fail the new booking.
 */
export function tokenFor(ref: { current: { key: string; token: string } | null }, key: string, make: () => string): string {
  if (ref.current?.key !== key) ref.current = { key, token: make() };
  return ref.current.token;
}
