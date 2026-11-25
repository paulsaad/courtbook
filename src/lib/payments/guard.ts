import "server-only";
import { PaymentStartRefused, type AttemptStatus, type PaymentProvider, type ProviderCharge, type StartAttemptInput, type StartAttemptResult } from "./provider";
import { isSafeRedirect, isUuid } from "./urls";

/**
 * M12.3: the provider-independent contract every payment provider is held to, whatever its API looks like.
 *
 * The payment engine (startFlow, attempts, reconcile) only ever talks to a provider through this guard. An adapter's
 * answers are checked before anything is recorded, so a provider bug, a changed API, a proxy error page or a forged
 * answer can never turn into a confirmed booking, a lost charge, or a payment wrongly marked failed:
 *
 *   start    the request is checked before it is sent (our own reference is a UUID, the amount is the attempt's, USD,
 *            https URLs); the answer must be a hosted page on https (optionally on the provider's own hosts) with a
 *            session reference, or — simulated provider only — immediate evidence. Anything else, or no answer within
 *            the time limit, is an UNKNOWN outcome (a plain error): the attempt stays unresolved and is settled by
 *            asking. Only the adapter's own PaymentStartRefused ends an attempt.
 *   status   exactly one of succeeded / failed / expired / pending / unknown. A success must carry well-formed evidence:
 *            a provider reference, a positive amount with at most two decimals, a three-letter currency code.
 *            A malformed answer or a timeout is "provider unavailable": nothing is recorded, the attempt stays
 *            unresolved and is asked about again. Well-formed evidence that DIFFERS from the attempt (another amount
 *            or currency) is passed on: the database records it and owes it back (wrong_amount / wrong_currency).
 *   list     the provider's charge list: every record well-formed, or the whole list is refused (the reconciliation
 *            run then reports `charge_list` and does not move its watermark — a partial list must never let the
 *            watermark pass a charge nobody looked at).
 *   callback only which attempt it is about, and only a UUID; whatever else it claims is never used (the server then
 *            asks the provider: a callback is a hint, not evidence).
 *
 * Nothing here knows any provider's API. Time limits are configuration, not provider facts.
 */
export class ProviderAnswerInvalid extends Error {
  readonly code: string;
  constructor(code: string) { super(`provider answer invalid: ${code}`); this.name = "ProviderAnswerInvalid"; this.code = code; }
}

export type GuardOptions = {
  startTimeoutMs?: number;
  statusTimeoutMs?: number;
  listTimeoutMs?: number;
  /** The provider's own payment-page hosts (exact, lower case). Empty: any https host is accepted. */
  pageHosts?: readonly string[];
};
export const GUARD_DEFAULTS = { startTimeoutMs: 15_000, statusTimeoutMs: 10_000, listTimeoutMs: 20_000 } as const;

const REF = /^[A-Za-z0-9._:\-]{1,128}$/;
const CURRENCY = /^[A-Za-z]{3}$/;   // the database compares upper(btrim()): "usd" is USD
const STATES = new Set(["succeeded", "failed", "expired", "pending", "unknown"]);

/** A money amount as a provider must report it: a finite number, more than 0, at most two decimals, under 1,000,000. */
export function validAmount(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1_000_000 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
}

export function validEvidence(e: unknown): e is { providerRef: string; amount: number; currency: string } {
  const x = e as { providerRef?: unknown; amount?: unknown; currency?: unknown } | null;
  return !!x && typeof x.providerRef === "string" && REF.test(x.providerRef) && validAmount(x.amount)
    && typeof x.currency === "string" && CURRENCY.test(x.currency);
}

/** Validate one status answer; throws ProviderAnswerInvalid for anything outside the contract. */
export function checkStatus(s: unknown): AttemptStatus {
  const x = s as { state?: unknown; evidence?: unknown } | null;
  if (!x || typeof x.state !== "string" || !STATES.has(x.state)) throw new ProviderAnswerInvalid("status_state");
  if (x.state === "succeeded") {
    if (!validEvidence(x.evidence)) throw new ProviderAnswerInvalid("status_evidence");
    const e = x.evidence;
    return { state: "succeeded", evidence: { providerRef: e.providerRef, amount: e.amount, currency: e.currency.toUpperCase() } };
  }
  return { state: x.state as "failed" | "expired" | "pending" | "unknown" };
}

export function checkCharges(list: unknown): ProviderCharge[] {
  if (!Array.isArray(list)) throw new ProviderAnswerInvalid("list_shape");
  return list.map((c) => {
    const x = c as { externalRef?: unknown; providerRef?: unknown; amount?: unknown; currency?: unknown } | null;
    if (!x || !validEvidence({ providerRef: x.providerRef, amount: x.amount, currency: x.currency })) throw new ProviderAnswerInvalid("list_record");
    if (!(x.externalRef === null || x.externalRef === undefined || typeof x.externalRef === "string")) throw new ProviderAnswerInvalid("list_record");
    const ext = typeof x.externalRef === "string" && x.externalRef.length <= 128 ? x.externalRef : null;
    return { externalRef: ext, providerRef: x.providerRef as string, amount: x.amount as number, currency: (x.currency as string).toUpperCase() };
  });
}

export function checkStart(r: unknown, simulated: boolean, pageHosts: readonly string[]): StartAttemptResult {
  const x = r as { kind?: unknown; url?: unknown; session?: unknown; evidence?: unknown } | null;
  if (x?.kind === "immediate") {
    if (!simulated) throw new ProviderAnswerInvalid("start_immediate");   // a real provider never answers with money at once
    if (!validEvidence(x.evidence)) throw new ProviderAnswerInvalid("start_evidence");
    return { kind: "immediate", evidence: x.evidence };
  }
  if (x?.kind !== "redirect") throw new ProviderAnswerInvalid("start_kind");
  if (typeof x.url !== "string" || x.url.length > 2048 || !isSafeRedirect(x.url)) throw new ProviderAnswerInvalid("start_url");
  if (pageHosts.length && !pageHosts.includes(new URL(x.url).hostname.toLowerCase())) throw new ProviderAnswerInvalid("start_host");
  if (typeof x.session !== "string" || !REF.test(x.session)) throw new ProviderAnswerInvalid("start_session");
  return { kind: "redirect", url: x.url, session: x.session };
}

/** Our own request, checked before it leaves: a mistake here must never reach a provider. */
export function checkStartInput(i: StartAttemptInput): void {
  if (!isUuid(i.attemptId)) throw new PaymentStartRefused("bad_reference");
  if (!validAmount(i.amountUsd)) throw new PaymentStartRefused("bad_amount");
  if (i.currency !== "USD") throw new PaymentStartRefused("bad_currency");
  if (!isSafeRedirect(i.returnUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(i.returnUrl)) throw new PaymentStartRefused("bad_return_url");
  if (!isSafeRedirect(i.callbackUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(i.callbackUrl)) throw new PaymentStartRefused("bad_callback_url");
}

/** Resolves with the promise, or rejects after ms (the provider call itself is left to finish; its answer is ignored). */
export function within<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new ProviderAnswerInvalid(code)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export function guardProvider(p: PaymentProvider, opts: GuardOptions = {}): PaymentProvider {
  const o = { ...GUARD_DEFAULTS, ...opts };
  const hosts = (opts.pageHosts ?? []).map((h) => h.toLowerCase());
  const simulated = p.name === "simulated";
  const guarded: PaymentProvider = {
    name: p.name,
    start: (i) => p.start(i),
    verify: (a, b) => p.verify(a, b),
    refund: (a, b) => p.refund(a, b),
    async startAttempt(input) {
      checkStartInput(input);                                           // refused: nothing was sent
      // a refusal from the adapter passes through untouched; anything else that is not a valid answer is UNKNOWN
      const r = await within(p.startAttempt(input), o.startTimeoutMs, "start_timeout");
      return checkStart(r, simulated, hosts);
    },
    async attemptStatus(attemptId) {
      if (!isUuid(attemptId)) throw new ProviderAnswerInvalid("status_reference");
      return checkStatus(await within(p.attemptStatus(attemptId), o.statusTimeoutMs, "status_timeout"));
    },
  };
  if (p.callbackAttemptId) {
    const cb = p.callbackAttemptId.bind(p);
    guarded.callbackAttemptId = async (req) => { const id = await cb(req); return isUuid(id) ? id : null; };
  }
  if (p.listCharges) {
    const list = p.listCharges.bind(p);
    guarded.listCharges = async (since, until) => checkCharges(await within(list(since, until), o.listTimeoutMs, "list_timeout"));
  }
  return guarded;
}
