/**
 * The app link the payment page hands back to (M12.4). Only the two CourtBook app schemes are accepted, from this
 * deployment's PAYMENT_APP_SCHEME (staging: courtbook-staging, live: courtbook); anything else means no app link.
 * The link carries nothing: the app asks the server where the payment stands.
 */
export const APP_SCHEMES = ["courtbook", "courtbook-staging"] as const;

export function appReturnLink(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.PAYMENT_APP_SCHEME;
  return s && (APP_SCHEMES as readonly string[]).includes(s) ? `${s}://payment-return` : null;
}
