/**
 * What a player will actually pay, and when.
 *
 * The club page used to print `service_fee_usd` whatever the club's payment mode was. At an
 * `at_desk` club `book_at_desk()` writes `fee_usd = 0` and creates no payment at all, so the page
 * was promising a $1 fee that would never be charged — to every player of the pilot, since the pilot
 * runs on `at_desk`. The fee a page shows has to come from the same thing that decides the charge.
 *
 * Kept here, apart from the page, because it is the sort of rule that gets quietly re-typed into a
 * second component and then disagrees with the first.
 */

export type PaymentMode = "simulated" | "at_desk";

export type FeeSummary = {
  /** The right-hand side of the "Booking fee" row. */
  fee: string;
  /** How and when money changes hands, or null when there is nothing worth saying. */
  payment: string | null;
};

export function feeSummary(mode: PaymentMode | string | null, serviceFeeUsd: number | string): FeeSummary {
  const fee = Number(serviceFeeUsd);
  if (mode === "at_desk") {
    // No CourtBook fee, and the court itself is settled in person.
    return { fee: "None", payment: "Pay the court at the club when you arrive." };
  }
  const amount = fee > 0 ? `$${fee.toFixed(2)} per booking` : "None";
  // Simulated is the testing provider: a payment row is written and a fee recorded, but nothing is
  // collected — `payments.collected` stays false and the staff dashboard reports it as test money.
  // Saying "paid online" here would contradict that on the one page a player reads before booking.
  if (mode === "simulated") return { fee: amount, payment: "Demo payment — no real money is charged." };
  // Anything else is a live gateway. Keep the online wording for that, and for a mode nobody has
  // taught this function about: overstating a cost is safer than promising free and then charging.
  return { fee: amount, payment: fee > 0 ? "Paid online when you reserve." : null };
}

export type PanelText = { priceLine: string; total: string; button: string; footnote: string };

/**
 * The words of the website's booking panels (club page and Courts page), from the club's payment mode.
 *
 * At an `at_desk` club `book_at_desk()` confirms at once, writes `fee_usd = 0` and creates no payment,
 * so the panel must not mention a booking fee, a total with a fee, paying, or a hold. Any other mode
 * reserves a held slot that is then paid in the app, with the club's service fee on top. The wording
 * matches the Courts page (BookSheet), which already said this.
 */
export function bookingPanelText(i: {
  mode: PaymentMode | string | null; courtUsd: number | null; serviceFeeUsd: number | string;
  holdMinutes: number; cutoffHours: number; signedIn: boolean; busy: boolean;
}): PanelText {
  const money = (v: number) => `$${v.toFixed(2)}`;
  const court = i.courtUsd === null ? "…" : money(i.courtUsd);
  if (i.mode === "at_desk") {
    return {
      priceLine: "Pay at the club",
      total: court,
      button: i.busy ? "Reserving…" : !i.signedIn ? "Sign in to reserve" : "Reserve — you pay at the club",
      footnote: `Confirmed straight away · nothing is paid through the app · free cancellation until ${i.cutoffHours} h before`,
    };
  }
  const fee = Number(i.serviceFeeUsd);
  const total = i.courtUsd === null ? null : i.courtUsd + fee;
  return {
    priceLine: `Court ${court} + booking fee ${money(fee)}`,
    total: total === null ? "…" : money(total),
    button: i.busy ? "Reserving…" : !i.signedIn ? "Sign in to reserve" : `Reserve and pay${total !== null ? ` ${money(total)}` : ""}`,
    footnote: `Slot held ${i.holdMinutes} minutes while you pay · free cancellation until ${i.cutoffHours} h before`,
  };
}
