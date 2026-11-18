/**
 * The club screen's Reserve button: its words and whether it can be pressed.
 *
 * Offline it is disabled and says why. This is presentation only: the reservation store still
 * refuses to send while offline (pendingReservation.ts submit()), because the connection can drop
 * between a render and a tap. An unresolved earlier booking keeps its own wording, offline or not.
 */
export type ReserveButtonInput = {
  phase: "idle" | "sending" | "checking" | "uncertain";
  signedIn: boolean;
  online: boolean;
  blocked: boolean; // an unresolved attempt at another club
  modePending: boolean; // the club's payment mode is still loading
  atDesk: boolean; // the club takes payment at the desk (the only mode the app reserves today)
  priceKnown: boolean;
};

export const OFFLINE_RESERVE_LABEL = "Connect to the internet to reserve";

export function reserveButton(i: ReserveButtonInput): { label: string; disabled: boolean } {
  const label =
    i.phase === "sending" ? "Reserving…"
    : i.phase === "checking" ? "Checking…"
    : i.phase === "uncertain" ? "Check now"
    : i.signedIn && i.blocked ? "Earlier booking not confirmed"
    : !i.online ? OFFLINE_RESERVE_LABEL
    : !i.signedIn ? "Sign in to reserve"
    : i.modePending ? "Checking the club…"
    : !i.atDesk ? "Reserve on the website for now"
    : "Reserve court";
  const disabled = i.phase === "idle" && (!i.online || (i.signedIn && (i.blocked || !i.atDesk || !i.priceKnown)));
  return { label, disabled };
}
