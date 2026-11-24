import { keepKeyAfterStart, keepKeyAfterStatus, readStart, readStatus, type StartAnswer, type StatusAnswer } from "./feePayment";

/**
 * The app's side of fee payments (M12.4): the request keys, the two server calls, and nothing else. No React and no
 * device modules here (they come in as `deps`), so the recovery rules are unit-tested.
 *
 *   - One request key per unresolved tap, written to the phone's secure storage BEFORE the request is sent, per
 *     account. Repeating the key always gets the same attempt from the server, so a double tap, a retry after a lost
 *     answer, or a tap after the app was killed can never start a second payment.
 *   - One entry PER PAYMENT (review of PR #37): opening another booking's payment screen adds its own entry and never
 *     replaces another one. An entry is removed only when the server has said where that payment ended (confirmed,
 *     hold ended, refund due, cancelled) or the player released the hold — never because another payment was opened.
 *     A key inside an entry is dropped only when the server says that payment's attempt ended.
 *   - Nothing is ever sent again on its own. Reads (status) are; starts never are.
 *   - Another account on the same phone sees nothing of this (the storage key carries the user id, and the server
 *     answers only the token's own payments).
 */
export type StoredPayment = { bookingId: string; paymentId: string; requestKey: string | null; savedAt: number };
type Record_ = { v: 2; userId: string; entries: StoredPayment[] };

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
/** Ended at the server: nothing left for this phone to recover. */
const ENDED = new Set(["confirmed", "hold_expired", "refund_due", "cancelled"]);

const isEntry = (e: unknown): e is StoredPayment => {
  const x = e as StoredPayment;
  return !!x && typeof x.bookingId === "string" && typeof x.paymentId === "string" && (x.requestKey === null || typeof x.requestKey === "string");
};

function parse(raw: string | null, userId: string): StoredPayment[] {
  if (!raw) return [];
  try {
    const s = JSON.parse(raw) as Record_ | (StoredPayment & { v: 1; userId: string });
    if (!s || s.userId !== userId) return [];                       // another account's (or a copied) record is not believed
    if (s.v === 2 && Array.isArray(s.entries)) return s.entries.filter(isEntry);
    if (s.v === 1 && isEntry(s)) return [{ bookingId: s.bookingId, paymentId: s.paymentId, requestKey: s.requestKey, savedAt: Number(s.savedAt) || 0 }];
    return [];
  } catch { return []; }
}

export class PayController {
  private inFlight: Promise<unknown> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private deps: PayDeps) {}

  /** Storage changes one at a time, each reading what the last one wrote. Returns false if it could not be saved. */
  private change(userId: string, f: (entries: StoredPayment[]) => StoredPayment[]): Promise<boolean> {
    const run = this.queue.then(async () => {
      let entries: StoredPayment[];
      try { entries = parse(await this.deps.storage.getItem(paymentStorageKey(userId)), userId); } catch { return false; }
      const next = f(entries.map((e) => ({ ...e })));
      try {
        if (next.length === 0) await this.deps.storage.removeItem(paymentStorageKey(userId));
        else await this.deps.storage.setItem(paymentStorageKey(userId), JSON.stringify({ v: 2, userId, entries: next } satisfies Record_));
        return true;
      } catch { return false; }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async entries(userId: string): Promise<StoredPayment[]> {
    await this.queue;
    try { return parse(await this.deps.storage.getItem(paymentStorageKey(userId)), userId); } catch { return []; }
  }

  async entry(userId: string, paymentId: string): Promise<StoredPayment | null> {
    return (await this.entries(userId)).find((e) => e.paymentId === paymentId) ?? null;
  }

  /** The payment to reopen after the app comes back from the payment page uninvited: one with a key (a tap whose
   *  outcome is not known yet) first, most recent first; otherwise the most recent one. */
  async toRecover(userId: string): Promise<StoredPayment | null> {
    const all = (await this.entries(userId)).sort((a, b) => b.savedAt - a.savedAt);
    return all.find((e) => e.requestKey) ?? all[0] ?? null;
  }

  /** Remember a payment this account opened. Adds its entry; never touches another payment's. */
  async remember(userId: string, bookingId: string, paymentId: string): Promise<void> {
    await this.change(userId, (es) => es.some((e) => e.paymentId === paymentId)
      ? es
      : [...es, { bookingId, paymentId, requestKey: null, savedAt: this.deps.now() }]);
  }

  /** Remove one payment's entry (its hold was released). Others are untouched. */
  async forget(userId: string, paymentId: string): Promise<void> {
    await this.change(userId, (es) => es.filter((e) => e.paymentId !== paymentId));
  }

  /** Busy with a start or a check: a second tap is ignored rather than queued. */
  get busy() { return this.inFlight !== null; }

  private guard<T>(run: () => Promise<T>): Promise<T | { kind: "busy" }> {
    if (this.inFlight) return Promise.resolve({ kind: "busy" as const });
    const p = run();
    this.inFlight = p;
    return p.finally(() => { this.inFlight = null; });
  }

  /** The player tapped Pay (or Continue payment). */
  async start(userId: string, bookingId: string, paymentId: string): Promise<StartAnswer | { kind: "busy" } | { kind: "offline" } | { kind: "not-saved" }> {
    if (!this.deps.isOnline()) return { kind: "offline" };             // nothing sent
    return this.guard(async () => {
      let key = (await this.entry(userId, paymentId))?.requestKey ?? null;
      if (!key) {
        const fresh = this.deps.newKey();
        // the key must survive the app being killed before the answer arrives; if it cannot be kept, nothing is sent
        const saved = await this.change(userId, (es) => {
          const mine = es.find((e) => e.paymentId === paymentId);
          if (mine) { mine.requestKey = mine.requestKey ?? fresh; mine.savedAt = this.deps.now(); return es; }
          return [...es, { bookingId, paymentId, requestKey: fresh, savedAt: this.deps.now() }];
        });
        if (!saved) return { kind: "not-saved" as const };
        key = (await this.entry(userId, paymentId))?.requestKey ?? null;
        if (!key) return { kind: "not-saved" as const };
      }
      const res = await this.deps.post("/api/native/pay/start", { paymentId, requestKey: key });
      const answer = res ? readStart(res.status, res.body) : ({ kind: "unknown" } as const);
      if (!keepKeyAfterStart(answer)) await this.change(userId, (es) => es.map((e) => (e.paymentId === paymentId && e.requestKey === key ? { ...e, requestKey: null } : e)));
      return answer;
    });
  }

  /** Where one payment stands, and that entry updated from the answer. Not guarded (used by check and settleOthers). */
  private async statusOf(userId: string, paymentId: string): Promise<StatusAnswer> {
    const res = await this.deps.post("/api/native/pay/status", { paymentId });
    const answer = res ? readStatus(res.status, res.body) : ({ kind: "unknown" } as const);
    if (answer.kind === "status") {
      const st = answer.status;
      if (ENDED.has(st.state)) await this.change(userId, (es) => es.filter((e) => e.paymentId !== paymentId));
      else if (!keepKeyAfterStatus(st)) await this.change(userId, (es) => es.map((e) => (e.paymentId === paymentId ? { ...e, requestKey: null } : e)));
    }
    return answer;                                                     // refused / unknown / auth / temporary: the entry stays as it was
  }

  /** Where the payment stands (a read). Safe to call on return, on resume, on reopen, or on a tap. */
  async check(userId: string, paymentId: string): Promise<StatusAnswer | { kind: "busy" } | { kind: "offline" }> {
    if (!this.deps.isOnline()) return { kind: "offline" };
    return this.guard(() => this.statusOf(userId, paymentId));
  }

  /** Read the state of this account's OTHER remembered payments, so the ones that have ended are tidied away and the
   *  ones that have not stay remembered. Reads only. */
  async settleOthers(userId: string, paymentId: string): Promise<void> {
    if (!this.deps.isOnline()) return;
    for (const e of await this.entries(userId)) if (e.paymentId !== paymentId) await this.statusOf(userId, e.paymentId);
  }
}
