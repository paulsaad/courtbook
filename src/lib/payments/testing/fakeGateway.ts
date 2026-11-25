import type { AttemptStatus, PaymentProvider, ProviderCharge, ProviderName, StartAttemptInput, StartAttemptResult } from "../provider";
import { PaymentStartRefused } from "../provider";

/**
 * A fake payment gateway for provider-independent tests (M12.2). It models GENERIC gateway behaviours that the
 * attempt design must survive — it is NOT a model of Whish, whose behaviour is unverified. Every behaviour is a knob a
 * test turns on explicitly:
 *  - payment pages that expire after `pageMinutes`, with no notice;
 *  - a start that is refused, or that times out after (or before) the gateway created the page;
 *  - callbacks that are lost, sent once, or forged (callbackAttemptId reads only the reference);
 *  - status answers: pending, succeeded, failed, expired, or "unknown" (the gateway never heard of the reference);
 *  - charges in its own list that the status never shows: a second charge on a page, a different amount or currency,
 *    or a charge with a reference that is not ours;
 *  - an outage of the status or list API;
 *  - (M12.3) charges that reach its own list only `listDelayMs` after they were taken; status calls that fail for
 *    chosen references only (`statusFailFor`); malformed status answers for chosen references (`statusAnswer`).
 * Time comes from `clock` so tests can move it.
 */
type Charge = ProviderCharge & { at: number };   // when the gateway took it (its own list is filtered by this)
type Page = { attemptId: string; created: number; amount: number; currency: string; state: "open" | "paid" | "failed"; charges: Charge[] };
export type StartMode = "ok" | "refused" | "timeout_after_create" | "timeout_before_create";

export class FakeGateway implements PaymentProvider {
  readonly name: ProviderName;
  pages = new Map<string, Page>();
  foreign: Charge[] = [];
  nextStart: StartMode[] = [];
  statusDown = false;
  listDown = false;
  pageMinutes = 5;
  listDelayMs = 0;
  statusFailFor = new Set<string>();
  statusAnswer = new Map<string, unknown>();
  startCalls = 0;
  private seq = 0;
  clock: () => number;
  constructor(clock: () => number = () => Date.now(), name: ProviderName = "whish") { this.clock = clock; this.name = name; }

  async start(): Promise<never> { throw new Error("Model 1 not used"); }
  async verify(): Promise<never> { throw new Error("Model 1 not used"); }
  async refund() { return { ok: false, reason: "refunds are recorded by hand" }; }

  async startAttempt(input: StartAttemptInput): Promise<StartAttemptResult> {
    this.startCalls++;
    const mode = this.nextStart.shift() ?? "ok";
    if (mode === "refused") throw new PaymentStartRefused("declined by the fake gateway");
    if (mode === "timeout_before_create") throw new Error("timeout");
    this.pages.set(input.attemptId, { attemptId: input.attemptId, created: this.clock(), amount: input.amountUsd, currency: input.currency, state: "open", charges: [] });
    if (mode === "timeout_after_create") throw new Error("timeout");
    return { kind: "redirect", url: `https://gateway.example/pay/${input.attemptId}`, session: `S-${input.attemptId.slice(0, 8)}` };
  }

  /** The player pays the page (again, for a second charge). Optional different amount/currency. */
  pay(attemptId: string, opts: { amount?: number; currency?: string } = {}): ProviderCharge {
    const p = this.pages.get(attemptId);
    if (!p) throw new Error("no such page");
    if (p.state === "open" && this.expired(p)) throw new Error("page expired");
    const charge = { externalRef: attemptId, providerRef: `G-${++this.seq}`, amount: opts.amount ?? p.amount, currency: opts.currency ?? p.currency, at: this.clock() };
    p.charges.push(charge);
    p.state = "paid";
    return charge;
  }
  decline(attemptId: string) { const p = this.pages.get(attemptId); if (p) p.state = "failed"; }
  /** A charge in the gateway's list whose reference is not one of ours. */
  foreignCharge(amount = 1, currency = "USD", at = this.clock()): ProviderCharge { const c = { externalRef: `X-${++this.seq}`, providerRef: `G-${this.seq}`, amount, currency, at }; this.foreign.push(c); return c; }
  /** Let `ms` pass at the gateway the way the database tests let it pass: everything it holds moves into the past. */
  shiftBack(ms: number) {
    for (const p of this.pages.values()) { p.created -= ms; for (const c of p.charges) c.at -= ms; }
    for (const c of this.foreign) c.at -= ms;
  }
  /** Change what the gateway's own list says about a charge it already reported (contradictory evidence). */
  restate(providerRef: string, change: { amount?: number; currency?: string }) {
    for (const c of [...[...this.pages.values()].flatMap((p) => p.charges), ...this.foreign]) if (c.providerRef === providerRef) Object.assign(c, change);
  }
  /** How many times listCharges was asked, and for which windows. */
  listCalls: { since: number; until: number }[] = [];

  private expired(p: Page) { return this.clock() - p.created > this.pageMinutes * 60_000; }

  async attemptStatus(attemptId: string): Promise<AttemptStatus> {
    if (this.statusDown) throw new Error("status API down");
    if (this.statusFailFor.has(attemptId)) throw new Error("status API error for this reference");
    if (this.statusAnswer.has(attemptId)) return this.statusAnswer.get(attemptId) as AttemptStatus;
    const p = this.pages.get(attemptId);
    if (!p) return { state: "unknown" };
    if (p.state === "paid") return { state: "succeeded", evidence: { providerRef: p.charges[0].providerRef, amount: p.charges[0].amount, currency: p.charges[0].currency } };
    if (p.state === "failed") return { state: "failed" };
    return this.expired(p) ? { state: "expired" } : { state: "pending" };
  }

  async callbackAttemptId(request: Request): Promise<string | null> {
    const body = (await request.json().catch(() => null)) as { reference?: unknown } | null;
    return typeof body?.reference === "string" ? body.reference : null;
  }

  /** The gateway's own list: charges taken in [since, until). */
  async listCharges(since: Date, until: Date): Promise<ProviderCharge[]> {
    this.listCalls.push({ since: since.getTime(), until: until.getTime() });
    if (this.listDown) throw new Error("list API down");
    return [...[...this.pages.values()].flatMap((p) => p.charges), ...this.foreign]
      .filter((c) => c.at >= since.getTime() && c.at < until.getTime() && c.at + this.listDelayMs <= this.clock())
      .map((c) => ({ externalRef: c.externalRef, providerRef: c.providerRef, amount: c.amount, currency: c.currency }));
  }
}
