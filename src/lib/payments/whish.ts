import "server-only";
import type { PaymentProvider } from "./provider";

/**
 * Whish Pay "Collect" adapter — NOT IMPLEMENTED. Shape from the public Whish Collect spec:
 *   base: live https://whish.money/itel-service/api/  sandbox https://lb.sandbox.whish.money/itel-service/api/
 *   headers: channel, secret, websiteurl (merchant credentials; env vars WHISH_CHANNEL, WHISH_SECRET, WHISH_WEBSITE_URL)
 *   POST /payment/collect { amount, currency: 'USD'|'LBP', invoice, successCallbackUrl, failureCallbackUrl } → { collectUrl }
 * Open questions for Whish merchant support before implementing (see project doc "payments research"):
 *   1. server-to-server notification or a status endpoint (the callback URLs look like browser redirects);
 *   2. refund API;
 *   3. onboarding requirements (individual vs company), fees, settlement.
 * verify() must call a status endpoint, never trust the redirect alone.
 *
 * M12.1 (attempts): community reports of the Whish API, NOT confirmed by Whish, shape the provider-independent design —
 * a collect link works once and expires after about 5 minutes; a reused external reference replays the old request
 * (so every attempt has its own id); the callback is sent once and never on expiry (so the server polls
 * attemptStatus); refunds only from registered server IPs. Each must be confirmed in writing before this is written.
 */
export const whishProvider: PaymentProvider = {
  name: "whish",
  async start() { throw new Error("whish provider not configured"); },
  async verify() { throw new Error("whish provider not configured"); },
  async refund() { return { ok: false, reason: "whish provider not configured" }; },
  async startAttempt() { throw new Error("whish provider not configured"); },
  async attemptStatus() { throw new Error("whish provider not configured"); },
};
