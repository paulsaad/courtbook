import { keepKeyAfterStart, keepKeyAfterStatus, readStart, readStatus, type StartAnswer, type StatusAnswer } from "./feePayment";

/**
 * The app's side of one fee payment (M12.4): the request key, the two server calls, and nothing else. No React and no
 * device modules here (they come in as `deps`), so the recovery rules are unit-tested.
 *
 *   - One request key per unresolved tap, written to the phone's secure storage BEFORE the request is sent, per
 *     account. Repeating the key always gets the same attempt from the server, so a double tap, a retry after a lost
 *     answer, or a tap after the app was killed can never start a second payment.
 *   - The key is dropped only when the server says that attempt has ended.
 *   - Nothing is ever sent again on its own. An unknown outcome waits for the player to tap Check payment (a read) or
 *     Pay again (which repeats the same key, so it can only find the same attempt).
 *   - Another account on the same phone sees nothing of this (the storage key carries the user id, and the server
 *     answers only the token's own payments).
 */
export type StoredPayment = { v: 1; userId: string; bookingId: string; paymentId: string; requestKey: string | null; savedAt: number };

export type PayDeps = {
  storage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> };
  /** POST JSON to the CourtBook server with the player's token; null when there was no usable HTTP answer. */
  post: (path: "/api/native/pay/start" | "/api/native/pay/status", body: Record<string, string>) => Promise<{ status: number; body: unknown } | null>;
  newKey: () => string;
  isOnline: () => boolean;
  now: () => number;
};

const PREFIX = "courtbook.fee-payment.v1.";
export const paymentStorageKey = (userId: string) => `${PREFIX}${userId}`;

function parse(raw: string | null, userId: string): StoredPayment | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StoredPayment;
    return s && s.v === 1 && s.userId === userId && typeof s.bookingId === "string" && typeof s.paymentId === "string" ? s : null;
  } catch { return null; }
}

export class PayController {
  private inFlight: Promise<unknown> | null = null;
  constructor(private deps: PayDeps) {}

  async load(userId: string): Promise<StoredPayment | null> {
    try { return parse(await this.deps.storage.getItem(paymentStorageKey(userId)), userId); } catch { return null; }
  }

  private async save(s: StoredPayment): Promise<boolean> {
    try { await this.deps.storage.setItem(paymentStorageKey(s.userId), JSON.stringify(s)); return true; } catch { return false; }
  }

  /** Remember which payment this account is in the middle of (before the first tap; recovery after a restart). */
  async remember(userId: string, bookingId: string, paymentId: string): Promise<StoredPayment> {
    const cur = await this.load(userId);
    if (cur && cur.paymentId === paymentId) return cur;
    const s: StoredPayment = { v: 1, userId, bookingId, paymentId, requestKey: null, savedAt: this.deps.now() };
    await this.save(s);
    return s;
  }

  async forget(userId: string, paymentId?: string): Promise<void> {
    const cur = await this.load(userId);
    if (paymentId && cur && cur.paymentId !== paymentId) return;      // a different payment is not this screen's to drop
    try { await this.deps.storage.removeItem(paymentStorageKey(userId)); } catch { /* kept: the server still decides */ }
  }

  /** Busy with a start or a check: a second tap is ignored rather than queued. */
  get busy() { return this.inFlight !== null; }

  /** The player tapped Pay (or Continue payment). */
  async start(userId: string, bookingId: string, paymentId: string): Promise<StartAnswer | { kind: "busy" } | { kind: "offline" } | { kind: "not-saved" }> {
    if (this.inFlight) return { kind: "busy" };
    if (!this.deps.isOnline()) return { kind: "offline" };             // nothing sent
    const run = (async () => {
      const cur = (await this.load(userId)) ?? { v: 1 as const, userId, bookingId, paymentId, requestKey: null, savedAt: this.deps.now() };
      const s: StoredPayment = cur.paymentId === paymentId ? cur : { v: 1, userId, bookingId, paymentId, requestKey: null, savedAt: this.deps.now() };
      if (!s.requestKey) {
        s.requestKey = this.deps.newKey();
        s.savedAt = this.deps.now();
        // the key must survive the app being killed before the answer arrives; if it cannot be kept, nothing is sent
        if (!(await this.save(s))) return { kind: "not-saved" as const };
      }
      const res = await this.deps.post("/api/native/pay/start", { paymentId, requestKey: s.requestKey });
      const answer = res ? readStart(res.status, res.body) : ({ kind: "unknown" } as const);
      if (!keepKeyAfterStart(answer)) await this.save({ ...s, requestKey: null, savedAt: this.deps.now() });
      return answer;
    })();
    this.inFlight = run;
    try { return await run; } finally { this.inFlight = null; }
  }

  /** Where the payment stands (a read). Safe to call on return, on resume, on reopen, or on a tap. */
  async check(userId: string, paymentId: string): Promise<StatusAnswer | { kind: "busy" } | { kind: "offline" }> {
    if (this.inFlight) return { kind: "busy" };
    if (!this.deps.isOnline()) return { kind: "offline" };
    const run = (async () => {
      const res = await this.deps.post("/api/native/pay/status", { paymentId });
      const answer = res ? readStatus(res.status, res.body) : ({ kind: "unknown" } as const);
      if (answer.kind === "status") {
        const cur = await this.load(userId);
        if (cur && cur.paymentId === paymentId) {
          const st = answer.status.state;
          if (st === "confirmed" || st === "hold_expired" || st === "refund_due" || st === "cancelled") await this.forget(userId, paymentId);
          else if (!keepKeyAfterStatus(answer.status) && cur.requestKey) await this.save({ ...cur, requestKey: null, savedAt: this.deps.now() });
        }
      }
      return answer;
    })();
    this.inFlight = run;
    try { return await run; } finally { this.inFlight = null; }
  }
}
