/**
 * The club Info page's cancellation line (W1). It must not promise a refund rule for money CourtBook never took:
 * at a pay-at-the-club club nothing is paid through CourtBook (the same rule as the booking page's CancelButton).
 */
export function cancellationLine(paymentMode: string | null, cutoffHours: number): { label: string; text: string } {
  if (paymentMode === "at_desk")
    return { label: "Cancellation", text: `Free until ${cutoffHours} h before. Nothing is paid through CourtBook.` };
  return { label: "Free cancellation", text: `until ${cutoffHours} h before; no refund after` };
}
