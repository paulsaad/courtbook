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
  atDesk: boolean; // the club takes payment at the desk
  priceKnown: boolean;
  /** M12.4: a fee_online club AND this build pays the fee in the app (feePayment.reservableInApp). Absent → false. */
  feeOnline?: boolean;
  /** M12.4: this player already holds a court waiting for its fee. hold_slot would end that hold (one at a time),
   *  possibly with a payment page open, so nothing else is reserved until it is paid, released or ended. */
  held?: boolean;
};

export const HELD_LABEL = "Finish your held booking first";

export const OFFLINE_RESERVE_LABEL = "Connect to the internet to reserve";

export function reserveButton(i: ReserveButtonInput): { label: string; disabled: boolean } {
  const label =
    i.phase === "sending" ? "Reserving…"
    : i.phase === "checking" ? "Checking…"
    : i.phase === "uncertain" ? "Check now"
    : i.signedIn && i.blocked ? "Earlier booking not confirmed"
    : i.signedIn && i.held ? HELD_LABEL
    : !i.online ? OFFLINE_RESERVE_LABEL
    : !i.signedIn ? "Sign in to reserve"
    : i.modePending ? "Checking the club…"
    : i.feeOnline ? "Reserve and pay fee"
    : !i.atDesk ? "Reserve on the website for now"
    : "Reserve court";
  const inApp = i.atDesk || !!i.feeOnline;
  const disabled = i.phase === "idle" && (!i.online || (i.signedIn && (i.blocked || !!i.held || !inApp || !i.priceKnown)));
  return { label, disabled };
}
