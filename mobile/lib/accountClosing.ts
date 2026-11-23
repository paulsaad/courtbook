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
  "You've been signed out. We're processing the deletion of your data. Records a club or the law needs us to keep, " +
  "such as past bookings and payments, are kept without your name.";

export const CLOSE_MESSAGES: Record<string, string> = {
  staff_role: "You are staff at a club, so this account can't be deleted here. Contact CourtBook support.",
  admin_role: "Admin accounts can't be deleted here. Contact CourtBook support.",
};
export const CLOSE_FAILED = "That didn't work, and nothing was changed. Please try again.";

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

export async function closeMyAccount(rpc: Rpc, signOut: SignOut): Promise<{ ok: true } | { ok: false; message: string }> {
  let error: { message?: string } | null = null;
  try { ({ error } = await rpc("close_my_account", { p_via: "app" })); } catch { error = { message: "network" }; }
  if (error) {
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

/** At sign-in and cold start: a session for an account that is already closed (another device closed it) is ended. */
export async function signOutIfClosed(rpc: Rpc, signOut: SignOut): Promise<boolean> {
  const { data, error } = await rpc("my_account_deletion", {});
  if (error || !isClosed(data)) return false;
  await signOut({ scope: "local" });
  return true;
}
