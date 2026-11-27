import { BUNDLE_ID, variantFromAppId, type Variant } from "./variant";

/**
 * Paying the CourtBook booking fee in the app (M12.4, Model 2: the court is paid at the club, only the fee online).
 *
 * The app never talks to a payment provider and holds no provider or service credential. It asks the CourtBook
 * server — /api/native/pay/start and /api/native/pay/status — with the player's own Supabase access token in the
 * Authorization header (never in a URL), opens the payment page the server approved, and afterwards asks the server
 * where the payment stands. Coming back from the page proves nothing; only the server's status does.
 *
 * This file is pure (no React, no device modules) so every rule in it is unit-tested.
 */

// ------------------------------------------------------------------ switch and server (fail closed)

/**
 * The only CourtBook servers each app may send a payment request to. The staging app talks only to the staging
 * website, the live app only to the live one; nothing here is read from configuration, so a mistaken variable can
 * switch the feature off but can never point an app at the other environment's server.
 *
 * Staging: the `staging-web` branch of the `courtbook-staging` Vercel project (Vercel's branch-address pattern). That
 * project is behind Vercel Authentication for every deployment, so the app cannot reach it until a decision on that
 * protection is made — see docs/m12/m12-4-native-payments.md ("staging access"). Until then the staging app's
 * payment requests are refused by Vercel and the app says so; nothing is weakened here to work around it.
 */
export const PAYMENT_SERVER: Record<Variant, string> = {
  production: "https://courtbook-three.vercel.app",
  staging: "https://courtbook-staging-git-staging-web-paul-bc50.vercel.app",
};

export type PaymentConfig =
  | { enabled: true; server: string; variant: Variant | null }
  | { enabled: false; reason: "off" | "unknown-app" | "bad-dev-server" };

/**
 * On only when the build says EXPO_PUBLIC_FEE_PAYMENTS=1 (exactly). Distributed builds do not set it, so the feature
 * is off by default. In a native build the server is the fixed one for that app (above). Outside a native build (unit
 * tests, the browser layout check) only a local development server may be given.
 */
export function paymentConfig(appId: string | null | undefined, flag: string | undefined, devServer: string | undefined): PaymentConfig {
  if (flag !== "1") return { enabled: false, reason: "off" };
  if (appId) {
    const variant = variantFromAppId(appId);
    if (!variant || BUNDLE_ID[variant] !== appId) return { enabled: false, reason: "unknown-app" };
    return { enabled: true, server: PAYMENT_SERVER[variant], variant };
  }
  if (!devServer) return { enabled: false, reason: "bad-dev-server" };
  let u: URL;
  try { u = new URL(devServer); } catch { return { enabled: false, reason: "bad-dev-server" }; }
  const local = (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.protocol === "http:";
  if (!local || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return { enabled: false, reason: "bad-dev-server" };
  return { enabled: true, server: u.origin, variant: null };
}

/** The club modes the app can reserve. Anything else (simulated Model 1, a mode added later, unknown) → website. */
export function reservableInApp(mode: string | null | undefined, paymentsOn: boolean): boolean {
  return mode === "at_desk" || (mode === "fee_online" && paymentsOn);
}

// ------------------------------------------------------------------ what the server says

export const PAYMENT_STATES = ["confirmed", "awaiting_payment", "payment_open", "checking", "hold_expired", "refund_due", "cancelled"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];
export type PaymentStatus = {
  state: PaymentState;
  bookingStatus: string;
  paymentStatus: string;
  holdExpiresAt: string | null;
  attempt: { status: string; outcome: string | null; attemptNo: number } | null;
  attemptsLeft: number;
  refundsDue: number;
  /** 0098 (M1): true only when every attempt is known to have taken nothing. Missing or false: never "no fee was taken". */
  noFeeTaken: boolean;
};

/** What a start request came back with. `unknown`: no usable answer (offline, timeout, unreadable) — the outcome is
 *  not known, the request key is kept, nothing is retried on its own. */
export type StartAnswer =
  | { kind: "redirect"; url: string }
  | { kind: "finished"; outcome: string | null }        // the attempt ended in success (e.g. the simulated provider)
  | { kind: "ended"; state: string }                    // the attempt this key named failed or expired
  | { kind: "refused"; error: string; final: boolean }  // a named answer from the server
  | { kind: "auth" }                                    // the session was rejected: sign in again
  | { kind: "unknown" };

export type StatusAnswer =
  | { kind: "status"; status: PaymentStatus }
  | { kind: "refused"; error: string }
  | { kind: "auth" }
  | { kind: "unknown" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A payment page must be https before the app opens it (the server checks too). */
export function safePaymentPage(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}

export function readStart(httpStatus: number, body: unknown): StartAnswer {
  if (httpStatus === 401) return { kind: "auth" };
  if (!isObj(body)) return { kind: "unknown" };
  if (typeof body.redirect === "string") return safePaymentPage(body.redirect) ? { kind: "redirect", url: body.redirect } : { kind: "unknown" };
  if (typeof body.attempt === "string" && "outcome" in body) return { kind: "finished", outcome: typeof body.outcome === "string" ? body.outcome : null };
  if (typeof body.attempt === "string" && typeof body.state === "string") return { kind: "ended", state: body.state };
  if (typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error)) return { kind: "refused", error: body.error, final: body.final === true };
  return { kind: "unknown" };
}

export function readStatus(httpStatus: number, body: unknown): StatusAnswer {
  if (httpStatus === 401) return { kind: "auth" };
  if (!isObj(body)) return { kind: "unknown" };
  if (httpStatus === 200) {
    const s = body as Partial<PaymentStatus>;
    if (typeof s.state !== "string" || !(PAYMENT_STATES as readonly string[]).includes(s.state)) return { kind: "unknown" };   // never guessed
    return { kind: "status", status: {
      state: s.state as PaymentState,
      bookingStatus: String(s.bookingStatus ?? ""),
      paymentStatus: String(s.paymentStatus ?? ""),
      holdExpiresAt: typeof s.holdExpiresAt === "string" ? s.holdExpiresAt : null,
      attempt: isObj(s.attempt) ? { status: String(s.attempt.status), outcome: typeof s.attempt.outcome === "string" ? s.attempt.outcome : null, attemptNo: Number(s.attempt.attemptNo) || 0 } : null,
      attemptsLeft: Math.max(0, Math.min(3, Number(s.attemptsLeft) || 0)),
      refundsDue: Math.max(0, Number(s.refundsDue) || 0),
      noFeeTaken: s.noFeeTaken === true,
    } };
  }
  // the server could not read the payment's records right now: says nothing about the payment (review of PR #37)
  if (body.error === "payment_status_unavailable") return { kind: "unknown" };
  if (typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error)) return { kind: "refused", error: body.error };
  return { kind: "unknown" };
}

// ------------------------------------------------------------------ the request key (one per unresolved tap)

/**
 * Keep the request key after a start answer? The same key always names the same attempt, so it is kept while that
 * attempt may still be unresolved (a page, an unknown outcome, "in progress"), and dropped once it has ended — the
 * next tap then gets a new key and, if tries remain, a new attempt.
 */
export function keepKeyAfterStart(a: StartAnswer): boolean {
  switch (a.kind) {
    case "redirect": return true;
    case "unknown": return true;
    case "auth": return true;
    case "refused": return !a.final;
    case "finished": return false;
    case "ended": return false;
  }
}

/** After a status answer: the key is dropped only when the server says no attempt is unresolved. */
export function keepKeyAfterStatus(s: PaymentStatus): boolean {
  return s.state === "payment_open" || s.state === "checking";
}

// ------------------------------------------------------------------ what the payment screen shows

export const FEE_TERMS = "The CourtBook booking fee is not refunded if you cancel. It is refunded if the club cancels or your booking cannot be confirmed.";
export const TEST_MODE_NOTE = "Test mode: this is a demo club. No real money is taken.";

export type Primary = "pay" | "continue" | "check" | "view-booking" | "none";
export type PayView = {
  title: string;
  message: string | null;
  primary: Primary;
  primaryLabel: string;
  /** "Check payment" next to the primary action. */
  canCheck: boolean;
  /** Release the hold. Never while an attempt may still take money. */
  canAbandon: boolean;
  countdown: boolean;
  tone: "neutral" | "good" | "warn" | "bad";
};

const RETRY_FINAL: Record<string, string> = {
  hold_expired: "Your 10-minute hold has ended, so this booking can no longer be paid. The court is free for others again — you can reserve it again if it is still free.",
  attempts_exhausted: "Three payment attempts were used for this hold. Release it and reserve again to try once more.",
  not_payable: "This booking can't be paid any more.",
  wrong_payment_mode: "This club no longer takes the fee in the app. Open the booking for details.",
  payments_not_configured: "Payments are not available in the app right now. Nothing was charged.",
  gateway_error: "The payment provider couldn't start the payment. Nothing was charged. You can try again.",
  not_found: "This payment isn't one of yours.",
  bad_request: "Something went wrong. Nothing was charged.",
};

/** One message for an answer to "Pay" that did not open a page. */
export function startProblem(a: StartAnswer, online: boolean): string | null {
  if (a.kind === "unknown") return online
    ? "We couldn't reach CourtBook to confirm the payment started. Nothing will be tried again on its own — tap Check payment."
    : "You're offline. Nothing was sent. Reconnect, then tap Check payment.";
  if (a.kind === "auth") return "Your sign-in expired. Sign in again; your hold and any payment are kept.";
  if (a.kind === "refused") {
    if (a.error === "payment_uncertain") return "The payment provider didn't answer in time. You may or may not have been charged — tap Check payment. Don't pay again.";
    if (a.error === "payment_in_progress") return "A payment for this booking is already in progress. Tap Check payment.";
    return RETRY_FINAL[a.error] ?? "Something went wrong. Nothing was charged.";
  }
  // 0098 (M1 review S3): an expired attempt may be CourtBook's own timeout (unknown_timeout): never "nothing was charged"
  if (a.kind === "ended") return a.state === "failed" ? "That payment didn't go through. Nothing was charged." : "That payment page expired. If you were charged, the fee will be refunded.";
  return null;
}

/**
 * The screen for a known server state. `holdLeftMs` is from the device clock and is display only: the server decides
 * whether the hold is still live.
 */
// 0098 (M1, Paul 26 Nov): "No fee was taken" only when the provider said so (or nothing was sent to it)
export const HOLD_ENDED_NO_FEE = "Your 10-minute hold ended before a payment arrived. No fee was taken. You can reserve again if the court is still free.";
export const HOLD_ENDED_UNCERTAIN = "Your 10-minute hold ended. We couldn't confirm the payment. If you were charged, the fee will be refunded. You can reserve again if the court is still free.";
export const NOT_CONFIRMED_NOTE = "If you were charged, the fee will be refunded";

export function payView(s: PaymentStatus | null, opts: { holdLeftMs: number | null; online: boolean; busy: boolean }): PayView {
  const base = { message: null, canCheck: true, canAbandon: false, countdown: false, tone: "neutral" as const };
  if (!s) return { ...base, title: "Checking your booking…", primary: "none", primaryLabel: "", canCheck: opts.online };
  switch (s.state) {
    case "awaiting_payment": {
      const out = s.attemptsLeft <= 0;
      const late = opts.holdLeftMs !== null && opts.holdLeftMs <= 0;
      return {
        ...base, title: "Pay the booking fee to confirm",
        message: out ? RETRY_FINAL.attempts_exhausted : late ? "Your hold has run out. Tap Check payment to see whether it can still be confirmed." : s.attempt ? `${s.attemptsLeft} of 3 payment attempts left.` : null,
        primary: out || late ? "check" : "pay", primaryLabel: out || late ? "Check payment" : "Pay booking fee",
        canCheck: !out && !late, canAbandon: true, countdown: true, tone: out ? "warn" : "neutral",
      };
    }
    case "payment_open":
      return { ...base, title: "Payment in progress", message: "Finish paying on the payment page, or check whether it has gone through. Don't start a second payment.",
        primary: "continue", primaryLabel: "Continue payment", countdown: true, tone: "warn" };
    case "checking":
      return { ...base, title: "Checking your payment", message: "We don't know yet whether this payment went through. You won't be charged twice — check again in a moment.",
        primary: "check", primaryLabel: "Check payment", canCheck: false, tone: "warn" };
    case "confirmed":
      return { ...base, title: "Court booked", message: "Your booking fee is paid. Pay the court price at the club.", primary: "view-booking", primaryLabel: "See booking", canCheck: false, tone: "good" };
    case "hold_expired":
      return { ...base, title: "Hold ended", message: s.noFeeTaken ? HOLD_ENDED_NO_FEE : HOLD_ENDED_UNCERTAIN,
        primary: "none", primaryLabel: "", canCheck: false, tone: "bad" };
    case "refund_due":
      return { ...base, title: "Booking not confirmed — refund due",
        message: "Your payment arrived after the booking could no longer be confirmed. The booking fee will be refunded.", primary: "none", primaryLabel: "", canCheck: false, tone: "bad" };
    case "cancelled":
      return { ...base, title: "Booking cancelled", message: null, primary: "view-booking", primaryLabel: "See booking", canCheck: false, tone: "bad" };
  }
}

/** 0098 (M2): what release_hold answered. Before 0098 it answered nothing (void): treated as released, as before. */
export function releaseOutcome(data: unknown): "released" | "already_confirmed" | "already_closed" {
  return data === "already_confirmed" || data === "already_closed" ? data : "released";
}
export const RELEASE_TOO_LATE = { title: "Your payment went through", body: "Your payment went through: court booked. The hold was not released." } as const;

/** Where a just-made reservation goes: a pending hold never shows "Court booked". */
export function afterReserve(status: string): "booking-new" | "pay" | "booking" {
  if (status === "confirmed") return "booking-new";
  if (status === "pending") return "pay";
  return "booking";
}

// ------------------------------------------------------------------ the booking screen's fee line (Model 2)

export type FeeLine = { value: string; note: string };
/** The CourtBook fee on a fee_online booking, from the payment row the player can read. Unknown is never "Paid". */
export function feeLine(paymentStatus: string | null | undefined, fee: number, noFeeTaken = false): FeeLine {
  const amount = `$${fee.toFixed(2)}`;
  switch (paymentStatus) {
    case "paid": return { value: `${amount} paid`, note: "Paid online" };
    case "pending": return { value: `${amount} not paid yet`, note: "Awaiting payment" };
    case "refund_due": return { value: `${amount} refund due`, note: "Refund on its way" };
    case "refunded": return { value: `${amount} refunded`, note: "Refunded" };
    // 0098 (M1): the payment row alone cannot tell a provider's refusal from CourtBook's own timeout
    case "expired": case "failed": return { value: "Not paid", note: noFeeTaken ? "No fee was taken" : NOT_CONFIRMED_NOTE };
    default: return { value: "See details", note: "Fee status unavailable" };
  }
}

/** What cancelling a fee_online booking means for the fee (D1). Wording only; cancel_booking decides. */
export function feeCancelNote(paymentStatus: string | null | undefined, fee: number): string {
  if (fee <= 0) return "There was no booking fee.";
  if (paymentStatus === "paid") return `The $${fee.toFixed(2)} booking fee is not refunded when you cancel. It is refunded if the club cancels.`;
  return FEE_TERMS;
}
