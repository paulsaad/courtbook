import {
  FEE_TERMS, PAYMENT_SERVER, afterReserve, feeCancelNote, feeLine, keepKeyAfterStart, keepKeyAfterStatus, payView, paymentConfig,
  readStart, readStatus, reservableInApp, safePaymentPage, startProblem, type PaymentStatus,
} from "../lib/feePayment";
import { PayController, paymentStorageKey, type PayDeps } from "../lib/payController";
import { HELD_LABEL, reserveButton } from "../lib/reserveButton";
// Node's own modules (Jest runs in Node; the app's type settings have no Node types).
declare const require: (m: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
const nodeRequire = require;

const status = (over: Partial<PaymentStatus> = {}): PaymentStatus => ({
  state: "awaiting_payment", bookingStatus: "pending", paymentStatus: "pending", holdExpiresAt: null, attempt: null, attemptsLeft: 3, refundsDue: 0, ...over,
});

describe("G: the feature is off unless a build turns it on, and each app talks only to its own server", () => {
  it("off without EXPO_PUBLIC_FEE_PAYMENTS=1 exactly", () => {
    for (const f of [undefined, "", "0", "true", "yes", " 1", "1 "]) expect(paymentConfig("app.courtbook.mobile", f, undefined)).toEqual({ enabled: false, reason: "off" });
  });
  it("the staging app → the staging server only; the live app → the live server only; unknown apps → off", () => {
    expect(paymentConfig("app.courtbook.mobile.staging", "1", undefined)).toEqual({ enabled: true, server: PAYMENT_SERVER.staging, variant: "staging" });
    expect(paymentConfig("app.courtbook.mobile", "1", undefined)).toEqual({ enabled: true, server: PAYMENT_SERVER.production, variant: "production" });
    expect(paymentConfig("com.example.fake", "1", undefined)).toEqual({ enabled: false, reason: "unknown-app" });
    // a development server given to a native build is ignored: it can never redirect an installed app
    expect(paymentConfig("app.courtbook.mobile", "1", "http://localhost:3000")).toMatchObject({ server: PAYMENT_SERVER.production });
    expect(PAYMENT_SERVER.staging).not.toEqual(PAYMENT_SERVER.production);
    for (const s of Object.values(PAYMENT_SERVER)) expect(s).toMatch(/^https:\/\/[a-z0-9-]+\.vercel\.app$/);
  });
  it("outside a native build: only a plain localhost http origin; missing or anything else → off", () => {
    expect(paymentConfig(null, "1", "http://localhost:3000")).toEqual({ enabled: true, server: "http://localhost:3000", variant: null });
    expect(paymentConfig(null, "1", "http://127.0.0.1:3000/")).toEqual({ enabled: true, server: "http://127.0.0.1:3000", variant: null });
    for (const d of [undefined, "", "https://courtbook-three.vercel.app", "http://evil.example", "http://localhost:3000/api", "http://u:p@localhost:3000", "http://localhost.evil.example", "javascript:alert(1)"])
      expect(paymentConfig(null, "1", d)).toEqual({ enabled: false, reason: "bad-dev-server" });
  });
  it("A1: which club modes the app reserves — unknown and simulated modes stay on the website", () => {
    expect(reservableInApp("at_desk", false)).toBe(true);
    expect(reservableInApp("at_desk", true)).toBe(true);
    expect(reservableInApp("fee_online", true)).toBe(true);
    expect(reservableInApp("fee_online", false)).toBe(false);
    for (const m of ["simulated", "fee_offline", "", null, undefined, "AT_DESK"]) expect(reservableInApp(m, true)).toBe(false);
  });
});

describe("A2: where a reservation goes next", () => {
  it("a pending hold never shows 'Court booked'", () => {
    expect(afterReserve("confirmed")).toBe("booking-new");
    expect(afterReserve("pending")).toBe("pay");
    for (const s of ["expired", "cancelled", "no_show", "weird"]) expect(afterReserve(s)).toBe("booking");
  });
});

describe("the reserve button with fee payments", () => {
  const ready = { phase: "idle" as const, signedIn: true, online: true, blocked: false, modePending: false, atDesk: false, priceKnown: true };
  it("fee_online on: pressable, says it will ask for the fee", () => {
    expect(reserveButton({ ...ready, feeOnline: true })).toEqual({ label: "Reserve and pay fee", disabled: false });
  });
  it("fee_online off (or any other mode): the website, disabled", () => {
    expect(reserveButton({ ...ready, feeOnline: false })).toEqual({ label: "Reserve on the website for now", disabled: true });
  });
  it("a held court waiting for its fee blocks another reservation (hold_slot would end it), at any club and any mode", () => {
    for (const r of [{ ...ready, atDesk: true }, { ...ready, feeOnline: true }])
      expect(reserveButton({ ...r, held: true })).toEqual({ label: HELD_LABEL, disabled: true });
  });
  it("offline still wins over pressable fee_online", () => {
    expect(reserveButton({ ...ready, feeOnline: true, online: false }).disabled).toBe(true);
  });
});

describe("B2/B3: reading the server's answers — a redirect is never proof, unknown is never a result", () => {
  it("start answers", () => {
    expect(readStart(200, { redirect: "https://pay.example/s/1" })).toEqual({ kind: "redirect", url: "https://pay.example/s/1" });
    expect(readStart(200, { redirect: "http://pay.example/s/1" })).toEqual({ kind: "unknown" });          // never opened
    expect(readStart(200, { redirect: "javascript:alert(1)" })).toEqual({ kind: "unknown" });
    expect(readStart(200, { attempt: "a", outcome: "confirmed" })).toEqual({ kind: "finished", outcome: "confirmed" });
    expect(readStart(200, { attempt: "a", state: "failed" })).toEqual({ kind: "ended", state: "failed" });
    expect(readStart(409, { error: "hold_expired", final: true })).toEqual({ kind: "refused", error: "hold_expired", final: true });
    expect(readStart(502, { error: "payment_uncertain", final: false })).toEqual({ kind: "refused", error: "payment_uncertain", final: false });
    expect(readStart(401, { error: "not_authenticated" })).toEqual({ kind: "auth" });
    for (const b of [null, "x", [], {}, { error: "<script>" }]) expect(readStart(500, b)).toEqual({ kind: "unknown" });
  });
  it("status answers: only known states; anything else is unknown, never 'paid'", () => {
    expect(readStatus(200, status({ state: "confirmed" }))).toMatchObject({ kind: "status", status: { state: "confirmed" } });
    expect(readStatus(200, { ...status(), state: "paid" })).toEqual({ kind: "unknown" });
    expect(readStatus(200, { ...status(), state: undefined })).toEqual({ kind: "unknown" });
    expect(readStatus(404, { error: "not_found", final: true })).toEqual({ kind: "refused", error: "not_found" });
    // the server could not read the records (review of PR #37): unknown, never a refusal or a state
    expect(readStatus(503, { error: "payment_status_unavailable", final: false })).toEqual({ kind: "unknown" });
    expect(readStatus(401, {})).toEqual({ kind: "auth" });
    expect(readStatus(200, { ...status(), attemptsLeft: 99 })).toMatchObject({ status: { attemptsLeft: 3 } });
  });
  it("only https payment pages, no credentials in them", () => {
    expect(safePaymentPage("https://pay.example/x?y=1")).toBe(true);
    for (const u of ["http://pay.example", "https://u:p@pay.example", "courtbook://x", "", 3, null, `https://x/${"a".repeat(3000)}`]) expect(safePaymentPage(u)).toBe(false);
  });
});

describe("C: the request key (M12.1 rules: same key → same attempt; never two unresolved)", () => {
  it("kept while the attempt may be unresolved, dropped when it has ended", () => {
    expect(keepKeyAfterStart({ kind: "redirect", url: "https://x" })).toBe(true);
    expect(keepKeyAfterStart({ kind: "unknown" })).toBe(true);
    expect(keepKeyAfterStart({ kind: "auth" })).toBe(true);
    expect(keepKeyAfterStart({ kind: "refused", error: "payment_uncertain", final: false })).toBe(true);
    expect(keepKeyAfterStart({ kind: "refused", error: "payment_in_progress", final: false })).toBe(true);
    expect(keepKeyAfterStart({ kind: "refused", error: "gateway_error", final: true })).toBe(false);
    expect(keepKeyAfterStart({ kind: "finished", outcome: "confirmed" })).toBe(false);
    expect(keepKeyAfterStart({ kind: "ended", state: "failed" })).toBe(false);
    expect(keepKeyAfterStatus(status({ state: "payment_open" }))).toBe(true);
    expect(keepKeyAfterStatus(status({ state: "checking" }))).toBe(true);
    for (const s of ["awaiting_payment", "confirmed", "hold_expired", "refund_due", "cancelled"] as const) expect(keepKeyAfterStatus(status({ state: s }))).toBe(false);
  });
});

/** A phone: secure storage that can fail, a server we script, a connection we switch. */
function phone() {
  const store = new Map<string, string>();
  const sent: Array<{ path: string; body: Record<string, string> }> = [];
  let answers: Array<{ status: number; body: unknown } | null | (() => Promise<{ status: number; body: unknown } | null>)> = [];
  let n = 0, clock = 0;
  const env = { online: true, storageFails: false };
  const deps: PayDeps = {
    storage: {
      getItem: async (k) => store.get(k) ?? null,
      setItem: async (k, v) => { if (env.storageFails) throw new Error("keystore"); store.set(k, v); },
      removeItem: async (k) => { store.delete(k); },
    },
    post: async (path, body) => { sent.push({ path, body }); const a = answers.shift(); return typeof a === "function" ? a() : (a ?? null); },
    newKey: () => `key-${++n}`,
    isOnline: () => env.online,
    now: () => (clock += 1_000),
  };
  return { store, sent, deps, env, answer: (...a: typeof answers) => { answers = a; } };
}

/** The request key stored on the phone for one payment of one account (undefined: no entry at all). */
function storedKey(store: Map<string, string>, user: string, payment: string): string | null | undefined {
  const raw = store.get(paymentStorageKey(user));
  if (!raw) return undefined;
  const e = (JSON.parse(raw).entries as { paymentId: string; requestKey: string | null }[]).find((x) => x.paymentId === payment);
  return e ? e.requestKey : undefined;
}

describe("C1–C3: recovery on the phone", () => {
  const U = "user-a", B = "booking-1", P = "payment-1";

  it("the key is stored BEFORE the request is sent, and the same key is sent again after a lost answer", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer(null);                                                       // answer lost
    expect(await c.start(U, B, P)).toEqual({ kind: "unknown" });
    expect(storedKey(ph.store, U, P)).toBe("key-1");
    ph.answer({ status: 200, body: { redirect: "https://pay.example/s/1" } });
    await c.start(U, B, P);
    expect(ph.sent.map((s) => s.body.requestKey)).toEqual(["key-1", "key-1"]);
  });

  it("the app killed and restarted: a new controller reads the stored key and reuses it", async () => {
    const ph = phone();
    ph.answer(null);
    await new PayController(ph.deps).start(U, B, P);
    const after = new PayController(ph.deps);                              // a new process
    expect((await after.toRecover(U))?.bookingId).toBe(B);
    ph.answer({ status: 200, body: { redirect: "https://pay.example/s/1" } });
    await after.start(U, B, P);
    expect(ph.sent.map((s) => s.body.requestKey)).toEqual(["key-1", "key-1"]);
  });

  it("a double tap sends one request; the second tap is ignored while the first is in flight", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    let release!: () => void;
    ph.answer(() => new Promise((ok) => { release = () => ok({ status: 200, body: { redirect: "https://pay.example/s/1" } }); }));
    const first = c.start(U, B, P);
    await new Promise((r) => setTimeout(r, 0));
    expect(await c.start(U, B, P)).toEqual({ kind: "busy" });
    expect(await c.check(U, P)).toEqual({ kind: "busy" });
    release();
    expect(await first).toEqual({ kind: "redirect", url: "https://pay.example/s/1" });
    expect(ph.sent).toHaveLength(1);
  });

  it("offline: nothing is sent and nothing is stored", async () => {
    const ph = phone();
    ph.env.online = false;
    const c = new PayController(ph.deps);
    expect(await c.start(U, B, P)).toEqual({ kind: "offline" });
    expect(await c.check(U, P)).toEqual({ kind: "offline" });
    expect(ph.sent).toEqual([]);
  });

  it("if the key cannot be stored, nothing is sent", async () => {
    const ph = phone();
    ph.env.storageFails = true;
    expect(await new PayController(ph.deps).start(U, B, P)).toEqual({ kind: "not-saved" });
    expect(ph.sent).toEqual([]);
  });

  it("nothing is ever retried on its own: an unknown outcome, then only reads until the player taps Pay", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer({ status: 502, body: { error: "payment_uncertain", final: false } },
      { status: 200, body: status({ state: "checking" }) }, { status: 200, body: status({ state: "checking" }) });
    await c.start(U, B, P);
    await c.check(U, P);
    await c.check(U, P);
    expect(ph.sent.map((s) => s.path)).toEqual(["/api/native/pay/start", "/api/native/pay/status", "/api/native/pay/status"]);
    expect(storedKey(ph.store, U, P)).toBe("key-1");   // kept: the attempt is unresolved
  });

  it("a failed attempt drops the key, so the next tap is a new attempt (if tries remain)", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer({ status: 200, body: { redirect: "https://pay.example/s/1" } }, { status: 200, body: status({ state: "awaiting_payment", attemptsLeft: 2, attempt: { status: "failed", outcome: null, attemptNo: 1 } }) },
      { status: 200, body: { redirect: "https://pay.example/s/2" } });
    await c.start(U, B, P);
    await c.check(U, P);
    await c.start(U, B, P);
    expect(ph.sent.filter((s) => s.path.endsWith("start")).map((s) => s.body.requestKey)).toEqual(["key-1", "key-2"]);
  });

  it("a final refusal drops the key; a final state forgets the payment", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer({ status: 409, body: { error: "hold_expired", final: true } }, { status: 200, body: status({ state: "hold_expired" }) });
    await c.start(U, B, P);
    expect(storedKey(ph.store, U, P)).toBeNull();
    await c.check(U, P);
    expect(ph.store.has(paymentStorageKey(U))).toBe(false);
  });

  it("an account switch: the other account sees nothing of it, and its own payment is separate", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer(null);
    await c.start(U, B, P);
    expect(await c.entries("user-b")).toEqual([]);
    ph.answer(null);
    await c.start("user-b", "booking-2", "payment-2");
    expect(storedKey(ph.store, "user-b", "payment-2")).toBe("key-2");
    expect(storedKey(ph.store, U, P)).toBe("key-1");
    // a stored record naming another user (tampered or copied) is not believed
    ph.store.set(paymentStorageKey("user-c"), ph.store.get(paymentStorageKey(U))!);
    expect(await c.entries("user-c")).toEqual([]);
  });

  it("no token, key or payment id ever goes into a URL", async () => {
    const ph = phone();
    ph.answer(null, null);
    const c = new PayController(ph.deps);
    await c.start(U, B, P);
    await c.check(U, P);
    expect(ph.sent.map((s) => s.path)).toEqual(["/api/native/pay/start", "/api/native/pay/status"]);
  });
});

describe("C (review of PR #37): another booking's payment never replaces an unresolved one", () => {
  const U = "user-a";
  const redirect = (n: number) => ({ status: 200, body: { redirect: `https://pay.example/s/${n}` } });
  const st = (state: string) => ({ status: 200, body: status({ state: state as PaymentStatus["state"] }) });
  const starts = (ph: ReturnType<typeof phone>) => ph.sent.filter((s) => s.path.endsWith("/start")).map((s) => `${s.body.paymentId}:${s.body.requestKey}`);

  it("screen switching: opening (and paying) another booking keeps the first payment's unresolved key; going back reuses it", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    await c.remember(U, "b1", "p1");
    ph.answer(null);                                                       // p1: answer lost — outcome unknown
    await c.start(U, "b1", "p1");
    await c.remember(U, "b2", "p2");                                       // the player opens another booking's screen
    expect(storedKey(ph.store, U, "p1")).toBe("key-1");
    expect(storedKey(ph.store, U, "p2")).toBeNull();
    ph.answer(redirect(2));
    await c.start(U, "b2", "p2");
    expect(storedKey(ph.store, U, "p1")).toBe("key-1");
    ph.answer(redirect(1));
    await c.start(U, "b1", "p1");                                          // back to the first: the SAME attempt
    expect(starts(ph)).toEqual(["p1:key-1", "p2:key-2", "p1:key-1"]);
  });

  it("reopening the app after visiting another booking: both are remembered, and the unresolved one is recovered first", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer(redirect(1));
    await c.start(U, "b1", "p1");                                          // p1's page is open
    await c.remember(U, "b2", "p2");                                       // p2 opened later, never paid
    const reopened = new PayController(ph.deps);                           // the app is killed and reopened
    expect((await reopened.entries(U)).map((e) => e.paymentId).sort()).toEqual(["p1", "p2"]);
    expect((await reopened.toRecover(U))?.bookingId).toBe("b1");          // the payment-return link opens p1, not the newer p2
  });

  it("returning from p1's payment page after visiting p2: p1's answer changes only p1", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer(redirect(1));
    await c.start(U, "b1", "p1");
    await c.remember(U, "b2", "p2");
    ph.answer(st("confirmed"));
    await c.check(U, "p1");
    expect(storedKey(ph.store, U, "p1")).toBeUndefined();                  // ended at the server: tidied away
    expect(storedKey(ph.store, U, "p2")).toBeNull();                        // untouched
  });

  it("other payments are removed only after the server says they ended — reads only, and an unknown answer keeps them", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer(null, redirect(3));
    await c.start(U, "b1", "p1");                                          // unknown
    await c.start(U, "b3", "p3");                                          // page open
    await c.remember(U, "b2", "p2");
    ph.sent.length = 0;
    ph.answer(null, st("payment_open"));                                  // p1: no answer; p3: still open
    await c.settleOthers(U, "p2");
    expect(ph.sent.every((s) => s.path.endsWith("/status"))).toBe(true);
    expect(storedKey(ph.store, U, "p1")).toBe("key-1");
    expect(storedKey(ph.store, U, "p3")).toBe("key-2");
    ph.answer({ status: 503, body: { error: "payment_status_unavailable", final: false } }, st("hold_expired"));
    await c.settleOthers(U, "p2");
    expect(storedKey(ph.store, U, "p1")).toBe("key-1");                    // a temporary server error establishes nothing
    expect(storedKey(ph.store, U, "p3")).toBeUndefined();                  // ended: removed
    expect(storedKey(ph.store, U, "p2")).toBeNull();
  });

  it("two screens writing at once never lose an entry", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer(null);
    await Promise.all([c.start(U, "b1", "p1"), c.remember(U, "b2", "p2"), c.remember(U, "b3", "p3"), c.remember(U, "b2", "p2")]);
    expect((await c.entries(U)).map((e) => e.paymentId).sort()).toEqual(["p1", "p2", "p3"]);
    expect(storedKey(ph.store, U, "p1")).toBe("key-1");
  });

  it("releasing one hold forgets only that payment", async () => {
    const ph = phone();
    const c = new PayController(ph.deps);
    ph.answer(null);
    await c.start(U, "b1", "p1");
    await c.remember(U, "b2", "p2");
    await c.forget(U, "p2");
    expect(storedKey(ph.store, U, "p1")).toBe("key-1");
    expect(storedKey(ph.store, U, "p2")).toBeUndefined();
  });
});

describe("B1: what the payment screen says", () => {
  const o = { holdLeftMs: 300_000, online: true, busy: false };
  it("awaiting payment: Pay, Check, Release, countdown", () => {
    expect(payView(status(), o)).toMatchObject({ primary: "pay", primaryLabel: "Pay booking fee", canCheck: true, canAbandon: true, countdown: true });
  });
  it("a page is open or the outcome unknown: never Pay again, never Release", () => {
    for (const s of ["payment_open", "checking"] as const) {
      const v = payView(status({ state: s }), o);
      expect(v.primary).not.toBe("pay");
      expect(v.canAbandon).toBe(false);
    }
    expect(payView(status({ state: "payment_open" }), o).primary).toBe("continue");
    expect(payView(status({ state: "checking" }), o).primary).toBe("check");
  });
  it("hold time up on the phone's clock: Check, not Pay (the server decides)", () => {
    expect(payView(status(), { ...o, holdLeftMs: 0 }).primary).toBe("check");
  });
  it("three attempts used: no Pay", () => {
    expect(payView(status({ attemptsLeft: 0 }), o).primary).toBe("check");
  });
  it("confirmed → booking; expired, refund due: explained, nothing to press but the booking", () => {
    expect(payView(status({ state: "confirmed" }), o)).toMatchObject({ title: "Court booked", primary: "view-booking" });
    expect(payView(status({ state: "hold_expired" }), o).message).toMatch(/No fee was taken/);
    expect(payView(status({ state: "refund_due" }), o).message).toMatch(/refunded/);
    expect(payView(null, o).title).toMatch(/Checking/);
  });
  it("'Court booked' only for confirmed", () => {
    for (const s of ["awaiting_payment", "payment_open", "checking", "hold_expired", "refund_due", "cancelled"] as const)
      expect(payView(status({ state: s }), o).title).not.toMatch(/booked/i);
  });
  it("the cancellation wording is exactly the approved sentence", () => {
    expect(FEE_TERMS).toBe("The CourtBook booking fee is not refunded if you cancel. It is refunded if the club cancels or your booking cannot be confirmed.");
  });
  it("an unknown start outcome tells the player not to pay again, and says nothing will be retried", () => {
    expect(startProblem({ kind: "refused", error: "payment_uncertain", final: false }, true)).toMatch(/Don't pay again/);
    expect(startProblem({ kind: "unknown" }, true)).toMatch(/Nothing will be tried again on its own/);
    expect(startProblem({ kind: "unknown" }, false)).toMatch(/offline/);
  });
});

describe("D: the fee on the booking screen", () => {
  it("each payment status in words; unknown is never 'paid'", () => {
    expect(feeLine("paid", 1)).toEqual({ value: "$1.00 paid", note: "Paid online" });
    expect(feeLine("pending", 1).note).toBe("Awaiting payment");
    expect(feeLine("refund_due", 1).note).toBe("Refund on its way");
    expect(feeLine("refunded", 1).note).toBe("Refunded");
    expect(feeLine("expired", 1).value).toBe("Not paid");
    for (const s of [undefined, null, "", "weird", "PAID"]) expect(feeLine(s, 1).value).not.toMatch(/paid$/i);
  });
  it("cancelling: the player's own cancellation keeps the fee; a $0 fee has nothing to say; no refund maths", () => {
    expect(feeCancelNote("paid", 1)).toBe("The $1.00 booking fee is not refunded when you cancel. It is refunded if the club cancels.");
    expect(feeCancelNote("paid", 0)).toBe("There was no booking fee.");
    expect(feeCancelNote(undefined, 1)).toBe(FEE_TERMS);
  });
});

describe("B2/G: the app carries no server or provider credential and no payment-provider logic", () => {
  const fs = nodeRequire("fs"), path = nodeRequire("path");
  const root = path.join(__dirname, "..");
  const files: string[] = [];
  (function walk(d: string) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { if (["app", "lib", "components", "shared"].includes(path.relative(root, p).split(path.sep)[0])) walk(p); }
      else if (/\.(ts|tsx|js|json)$/.test(f)) files.push(p);
    }
  })(root);
  const src = files.filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`)).map((f) => [f, fs.readFileSync(f, "utf8")] as const);

  it("no service-role key, cron secret or provider credential is referenced by app code", () => {
    expect(src.length).toBeGreaterThan(50);
    for (const [f, t] of src) expect([f, /SERVICE_ROLE|service_role|CRON_SECRET|WHISH_|PAYMENT_PROVIDER|sk_live|secret_key/i.test(t)]).toEqual([f, false]);
  });
  it("the app never calls a provider or the server-only payment functions itself", () => {
    for (const [f, t] of src) {
      expect([f, /rpc\(\s*["'](record_attempt_result|open_payment_attempt|abandon_payment_attempt|start_payment_attempt|confirm_payment|reconcile_provider_charge|complete_fee_refund)/.test(t)]).toEqual([f, false]);
      expect([f, /whish\.money|api\.whish|areeba/i.test(t)]).toEqual([f, false]);
    }
  });
  it("app.json / app.config: no new permission for payments", () => {
    const cfg = fs.readFileSync(path.join(root, "app.config.ts"), "utf8");
    expect(cfg).not.toMatch(/web-browser|payment/i);
  });
});
