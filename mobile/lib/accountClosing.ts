/**
 * M2 (0086): closing your own account from the app. One confirmation, no undo (D1); never says the data IS deleted (D5).
 *
 * The app does not call the website: close_my_account runs with the person's own session (the database decides who
 * may, and refuses staff and admins with nothing changed). From its commit every write by this account is refused.
 * Then the app signs out everywhere (refresh tokens revoked). Banning the sign-in, removing the data and deleting the
 * sign-in happen on the server (retry route or the admin page), not here.
 *
 * The wording is the website's (src/lib/deletion/copy.ts); a test keeps the two identical.
 */
export const CONFIRM_TITLE = "Delete your CourtBook account?";
export const CONFIRM_TEXT =
  "You'll be signed out straight away and can't undo this. Your upcoming bookings and the games you organise are " +
  "cancelled under the club's usual rules, and players in your games are told. Your name, phone number, email sign-in, " +
  "levels and chat messages are deleted. Records a club or the law needs, such as past bookings and payments, are kept " +
  "without your name.";
export const CLOSED_TITLE = "Your account is closed.";
export const CLOSED_TEXT =
  "We're processing the deletion of your data. You've been signed out. Records a club or the law needs us to keep, " +
  "such as past bookings and payments, are kept without your name.";

export const CLOSE_MESSAGES: Record<string, string> = {
  staff_role: "You are staff at a club, so this account can't be deleted here. Contact CourtBook support.",
  admin_role: "Admin accounts can't be deleted here. Contact CourtBook support.",
};
export const CLOSE_FAILED = "That didn't work, and nothing was changed. Please try again.";
/** Review 23 Nov: the app closes only while automatic processing runs (the website processes on the spot). */
export const PROCESSING_PAUSED = "Deleting your account from the app is paused for a moment, and nothing was changed. Please try again later, or delete it on the CourtBook website: Profile → Delete my account.";
/** Review 23 Nov: closing needs a recent sign-in; a stale session gets an email code first, then the same confirmation. */
export const REAUTH_TEXT = "For your security, enter the sign-in code we've just emailed to";
/** Same wording as the website (src/lib/deletion/copy.ts legacyRequestText). */
export function legacyRequestText(requestedAt: string | null | undefined): string {
  const t = requestedAt ? new Date(requestedAt) : null;
  const when = t && !Number.isNaN(t.getTime())
    ? new Date(t.getTime() + 24 * 3_600_000).toLocaleString("en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Beirut" })
    : null;
  return `You asked to delete your account in the app. ${when ? `It will be deleted after ${when} (Beirut time)` : "It will be deleted within a day"} unless you keep it. Until then you can't make bookings, join games or send messages.`;
}

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
type SignOut = (opts: { scope: "global" | "local" }) => PromiseLike<{ error: unknown } | unknown>;

const isClosed = (data: unknown) => !!(data && typeof data === "object" && (data as { closed?: unknown }).closed === true);

async function signOutEverywhere(signOut: SignOut) {
  try {
    const r = (await signOut({ scope: "global" })) as { error?: unknown } | undefined;
    if (r?.error) await signOut({ scope: "local" });
  } catch {
    try { await signOut({ scope: "local" }); } catch { /* the database lock-out still applies */ }
  }
}

export type CloseResult = { ok: true } | { ok: false; message: string } | { ok: false; reauth: true };

export async function closeMyAccount(rpc: Rpc, signOut: SignOut): Promise<CloseResult> {
  let error: { message?: string } | null = null;
  try { ({ error } = await rpc("close_my_account", { p_via: "app" })); } catch { error = { message: "network" }; }
  if (error) {
    if (error.message === "reauth_required") return { ok: false, reauth: true };   // nothing written; ask for a code
    if (error.message === "processing_unavailable") return { ok: false, message: PROCESSING_PAUSED };
    const refused = CLOSE_MESSAGES[error.message ?? ""];
    if (refused) return { ok: false, message: refused };
    // the close may have committed before the answer was lost: if the account is closed, carry on
    try {
      const s = await rpc("my_account_deletion", {});
      if (!s.error && isClosed(s.data)) { await signOutEverywhere(signOut); return { ok: true }; }
    } catch { /* offline */ }
    return { ok: false, message: CLOSE_FAILED };
  }
  await signOutEverywhere(signOut);
  return { ok: true };
}

type Otp = {
  getUser: () => PromiseLike<{ data: { user: { email?: string | null } | null } }>;
  signInWithOtp: (a: { email: string; options: { shouldCreateUser: boolean } }) => PromiseLike<{ error: unknown }>;
  verifyOtp: (a: { email: string; token: string; type: "email" }) => PromiseLike<{ error: unknown }>;
};
/** Emails a sign-in code to the account's own address (never creates an account). Returns the address, or a message. */
export async function sendReauthCode(otp: Otp): Promise<{ email: string } | { message: string }> {
  const { data } = await otp.getUser();
  const email = data.user?.email;
  if (!email) return { message: "We couldn't send you a sign-in code. Contact CourtBook support to delete your account." };
  const { error } = await otp.signInWithOtp({ email, options: { shouldCreateUser: false } });
  return error ? { message: "We couldn't send the code just now. Please try again in a minute." } : { email };
}
/** A fresh sign-in from the code, then the same close. */
export async function verifyAndClose(otp: Otp, rpc: Rpc, signOut: SignOut, email: string, code: string): Promise<CloseResult> {
  const { error } = await otp.verifyOtp({ email, token: code.replace(/\D/g, ""), type: "email" });
  if (error) return { ok: false, message: "That code didn't work. Check it, or send a new one." };
  return closeMyAccount(rpc, signOut);
}

/** At sign-in and cold start: a session for an account that is already closed (another device closed it) is ended. */
export async function signOutIfClosed(rpc: Rpc, signOut: SignOut): Promise<boolean> {
  const { data, error } = await rpc("my_account_deletion", {});
  if (error || !isClosed(data)) return false;
  await signOut({ scope: "local" });
  return true;
}
