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

export type PaymentMode = "simulated" | "at_desk" | "fee_online";

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
  // M12.1: the court is paid at the club; only CourtBook's booking fee is paid online, and it is kept if the player
  // cancels (decision D1). A $0 fee is the pay-at-the-desk path: nothing online at all.
  if (mode === "fee_online") {
    if (!(fee > 0)) return { fee: "None", payment: "Pay the court at the club when you arrive." };
    return { fee: `${amount}, paid online — not refunded if you cancel`, payment: "Pay the court at the club when you arrive. The booking fee is paid online when you reserve." };
  }
  // Anything else is a live gateway. Keep the online wording for that, and for a mode nobody has
  // taught this function about: overstating a cost is safer than promising free and then charging.
  return { fee: amount, payment: fee > 0 ? "Paid online when you reserve." : null };
}

/** The reserve sheet's price line, button and small print — one place, so the sheets cannot disagree (M12.1). */
export type ReserveText = { label: string; amount: string; button: string; note: string };

export function reserveText(mode: PaymentMode | string | null, serviceFeeUsd: number | string, courtUsd: number | null,
  holdMinutes: number, cutoffHours: number): ReserveText {
  const fee = Number(serviceFeeUsd);
  const usd = (n: number | null) => (n === null ? "…" : `$${n.toFixed(2)}`);
  if (mode === "at_desk" || (mode === "fee_online" && !(fee > 0))) {
    return { label: "Pay at the club", amount: usd(courtUsd), button: "Reserve — you pay at the club",
      note: `Confirmed straight away · nothing is paid through the app · free cancellation until ${cutoffHours} h before` };
  }
  if (mode === "fee_online") {
    return { label: `Court ${usd(courtUsd)} at the club + booking fee now`, amount: usd(fee), button: `Reserve and pay the ${usd(fee)} booking fee`,
      note: `Slot held ${holdMinutes} minutes while you pay the booking fee · it is not refunded if you cancel` };
  }
  const total = courtUsd === null ? null : courtUsd + fee;
  return { label: `Court ${usd(courtUsd)} + booking fee ${usd(fee)}`, amount: usd(total), button: `Reserve and pay${total !== null ? ` ${usd(total)}` : ""}`,
    note: `Slot held ${holdMinutes} minutes while you pay · free cancellation until ${cutoffHours} h before` };
}
