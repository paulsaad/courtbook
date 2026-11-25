/**
 * The app's payment endpoints (M12.4) exist only where this deployment says so: NATIVE_PAYMENTS=1. Anything else —
 * unset, "true", "yes", " 1" — is off. This is a server switch on top of the app's own build switch; real money still
 * needs a real provider configured, which set_club_payment_mode and hold_slot already require (0094).
 */
export function nativePaymentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NATIVE_PAYMENTS === "1";
}
