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
  if (!(fee > 0)) return { fee: "None", payment: null };
  return { fee: `$${fee.toFixed(2)} per booking`, payment: "Paid online when you reserve." };
}
