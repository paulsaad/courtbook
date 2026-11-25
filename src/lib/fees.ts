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

export type PanelText = { priceLine: string; total: string; button: string; footnote: string };

/**
 * The words of the website's booking panels (club page and Courts page), from the club's payment mode — the one
 * rule both panels use, so they cannot disagree.
 *
 * - `at_desk` (and `fee_online` with a $0 fee): `book_at_desk()` confirms at once, writes `fee_usd = 0` and creates
 *   no payment, so the panel mentions no booking fee, no paying and no hold (pilot visual audit W1, #62).
 * - `fee_online` (M12.1): the court is paid at the club; only the booking fee is paid now, and it is kept if the
 *   player cancels (decision D1).
 * - `simulated` (demo): court + fee, held while the demo payment runs; says no real money is charged (#63).
 * - Anything else is treated as paid online in full: overstating a cost is safer than promising free.
 */
export function bookingPanelText(i: {
  mode: PaymentMode | string | null; courtUsd: number | null; serviceFeeUsd: number | string;
  holdMinutes: number; cutoffHours: number; signedIn: boolean; busy: boolean;
}): PanelText {
  const money = (v: number) => `$${v.toFixed(2)}`;
  const court = i.courtUsd === null ? "…" : money(i.courtUsd);
  const fee = Number(i.serviceFeeUsd);
  const action = (ready: string) => (i.busy ? "Reserving…" : !i.signedIn ? "Sign in to reserve" : ready);
  if (i.mode === "at_desk" || (i.mode === "fee_online" && !(fee > 0))) {
    return {
      priceLine: "Pay at the club",
      total: court,
      button: action("Reserve — you pay at the club"),
      footnote: `Confirmed straight away · nothing is paid through the app · free cancellation until ${i.cutoffHours} h before`,
    };
  }
  if (i.mode === "fee_online") {
    return {
      priceLine: `Court ${court} at the club + booking fee now`,
      total: money(fee),
      button: action(`Reserve and pay the ${money(fee)} booking fee`),
      footnote: `Slot held ${i.holdMinutes} minutes while you pay the booking fee · it is not refunded if you cancel`,
    };
  }
  const total = i.courtUsd === null ? null : i.courtUsd + fee;
  return {
    priceLine: `Court ${court} + booking fee ${money(fee)}`,
    total: total === null ? "…" : money(total),
    button: action(`Reserve and pay${total !== null ? ` ${money(total)}` : ""}`),
    // A simulated (demo) club collects nothing; say so before the player taps, as the pay page already does.
    footnote: `${i.mode === "simulated" ? `${DEMO_NOTE} · ` : ""}Slot held ${i.holdMinutes} minutes while you pay · free cancellation until ${i.cutoffHours} h before`,
  };
}

/** Shown wherever a simulated (demo) payment could be read as a real charge. Payment behaviour is unchanged. */
export const DEMO_NOTE = "Demo club: no real money is charged";

/** M12.1's shape of the same words (`label`, `amount`, `button` when ready, `note`); kept so its callers and tests
 *  stay as reviewed, but it is bookingPanelText underneath — there is one rule, not two. */
export type ReserveText = { label: string; amount: string; button: string; note: string };

export function reserveText(mode: PaymentMode | string | null, serviceFeeUsd: number | string, courtUsd: number | null,
  holdMinutes: number, cutoffHours: number): ReserveText {
  const t = bookingPanelText({ mode, courtUsd, serviceFeeUsd, holdMinutes, cutoffHours, signedIn: true, busy: false });
  return { label: t.priceLine, amount: t.total, button: t.button, note: t.footnote };
}
