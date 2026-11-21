/**
 * The emailed sign-in code.
 *
 * Its length is a setting of each Supabase project (Authentication → Email OTP Length, 6 to 10
 * digits), not something the app can read. The live project sends 8 digits; staging was set to 6.
 * So the app accepts any length Supabase can be set to — the same 6–10 rule as the website's
 * sign-in (src/app/login/LoginForm.tsx) — and the server decides whether the code is right.
 * A fixed 6 here was the 0.3.0 sign-in fault: an 8-digit live code could not be typed in.
 * The email carries the code only (no sign-in link): docs/m3/email/.
 */
export const CODE_MIN = 6;
export const CODE_MAX = 10;

/** Keeps the digits only, so a pasted "1234 5678" or "12345678\n" still works; at most CODE_MAX. */
export function cleanCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, CODE_MAX);
}

/** True when the code can be sent to Supabase (6–10 digits). */
export function codeReady(code: string): boolean {
  return new RegExp(`^[0-9]{${CODE_MIN},${CODE_MAX}}$`).test(code);
}
