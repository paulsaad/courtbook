/**
 * M2 (0086) wording, D5: simple, and never claiming the data IS deleted (processing may still be running, may be
 * retried later, or — held accounts — waits for a review). The app has its own copy (mobile/components/DeleteAccount.tsx);
 * keep the two in step.
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

/** Review 23 Nov: closing needs a recent sign-in; a stale session gets an email code first (then the same confirmation). */
export const REAUTH_TEXT = "For your security, enter the sign-in code we've just emailed to";

/**
 * A request made in an older app version (request-and-wait). That app promised it could be cancelled until processed;
 * it is processed automatically 24 hours after it was made.
 */
export function legacyRequestText(requestedAt: string | null | undefined): string {
  const t = requestedAt ? new Date(requestedAt) : null;
  const when = t && !Number.isNaN(t.getTime())
    ? new Date(t.getTime() + 24 * 3_600_000).toLocaleString("en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Beirut" })
    : null;
  return `You asked to delete your account in the app. ${when ? `It will be deleted after ${when} (Beirut time)` : "It will be deleted within a day"} unless you keep it. Until then you can't make bookings, join games or send messages.`;
}
