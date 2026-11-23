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
