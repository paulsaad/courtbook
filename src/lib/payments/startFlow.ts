import "server-only";
import { report } from "@/lib/report";
import { PaymentStartRefused, type PaymentProvider } from "./provider";
import { paymentCode, recordEvidence, verifyAndRecord } from "./attempts";
import { isSafeRedirect, isUuid, providerCallbackUrl } from "./urls";

/**
 * The one server-side payment engine for the CourtBook booking fee (M12.1 rules, 0093), shared by the website
 * (/api/pay/start, signed in by cookie) and the app (/api/native/pay/*, signed in by bearer token — M12.4). Each route
 * only establishes WHO the player is and builds a database client that acts as that player; everything else is here.
 *
 * - start_payment_attempt runs as the player: the database checks the payment is theirs, still payable, the hold
 *   live, at most three attempts, never two unresolved at once, and the same request key gives the same attempt.
 * - A tap while another attempt is unresolved asks the provider about that attempt first (never a second charge).
 * - A provider timeout is not a refusal: the attempt stays unresolved and is settled by asking the provider later.
 * - Only fixed codes go back to the caller; nothing of the database's or the provider's text, and no identifiers in
 *   reports.
 *
 * Answers: { redirect } | { attempt, outcome } (finished) | { attempt, state } | { error, final }. `final: false`
 * means the outcome is not known yet: the caller keeps its request key and retries with it.
 */
export type FlowResult = { status: number; body: Record<string, unknown> };

type Answer = { data: unknown; error: { message: string; code?: string } | null };
/** A database client acting as the signed-in player (row-level security and auth.uid() apply). */
export type PlayerDb = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Answer>;
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any -- supabase-js query builder
};
/** The service-role client (server only). */
export type AdminDb = PlayerDb;

export type FlowDeps = {
  player: PlayerDb;
  admin: AdminDb;
  provider: PaymentProvider;
  /** PAYMENT_SITE_URL's origin, or null when not configured. */
  origin: string | null;
  /** Where the provider sends the player back: the website's return page, or the app's (never a token in it). */
  returnUrl: (origin: string, attemptId: string) => string;
  sleep?: (ms: number) => Promise<void>;
};

const ok = (body: Record<string, unknown>, status = 200): FlowResult => ({ status, body });
/** No attempt is unresolved after these: the caller may forget its key. */
export const FINAL = new Set(["bad_request", "not_authenticated", "not_found", "token_required", "wrong_payment_mode", "not_payable",
  "hold_expired", "attempts_exhausted", "payments_not_configured", "gateway_error"]);
export const fail = (error: string, status: number, extra: Record<string, unknown> = {}): FlowResult => ({ status, body: { error, final: FINAL.has(error), ...extra } });

const STATUS: Record<string, number> = {
  not_authenticated: 401, not_found: 404, token_required: 400, wrong_payment_mode: 409, not_payable: 409,
  hold_expired: 409, attempts_exhausted: 409, payments_not_configured: 503, attempt_in_progress: 409,
};

type AttemptRow = { attempt_id: string; attempt_no: number; provider: string; amount_usd: number | string; currency: string; status: string; session_url: string | null; already: boolean };
type Unresolved = { id: string; status: string; session_url: string | null; outcome: string | null; created_at?: string | null };
const UNRESOLVED = ["starting", "open"];

async function readAttempt(admin: AdminDb, id: string): Promise<Unresolved | null> {
  const { data } = await admin.from("payment_attempts").select("id, status, session_url, outcome, created_at").eq("id", id).single();
  return (data as Unresolved | null) ?? null;
}

/** Ask the provider about an unresolved attempt and record its answer; then what the attempt is now. */
async function settle(admin: AdminDb, provider: PaymentProvider, attemptId: string, createdAt?: string | null): Promise<Unresolved | null> {
  // createdAt lets a provider's "never heard of it" end the attempt after UNKNOWN_GRACE_MINUTES (M12.2)
  const r = await verifyAndRecord(admin, provider, attemptId, { createdAt: createdAt ?? (await readAttempt(admin, attemptId))?.created_at });
  if (!r.ok) await report(r.code === "provider_unavailable" ? "paymentProvider" : "paymentRecord", "payment", { code: r.code });
  return readAttempt(admin, attemptId);
}

/** What to tell the caller about an attempt that already exists. */
function answerFor(a: Unresolved): FlowResult {
  if (a.status === "open" && a.session_url) return ok({ redirect: a.session_url });
  if (UNRESOLVED.includes(a.status)) return fail("payment_in_progress", 409);   // starting, or open with no usable page
  if (a.status === "succeeded") return ok({ attempt: a.id, outcome: a.outcome });
  return ok({ attempt: a.id, state: a.status });                                // failed / expired: this tap is over
}

export async function startFeePayment(d: FlowDeps, input: { paymentId: unknown; requestKey: unknown }): Promise<FlowResult> {
  const { paymentId, requestKey } = input;
  if (!isUuid(paymentId) || !isUuid(requestKey)) return fail("bad_request", 400);
  const { player, admin, provider } = d;
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let a: AttemptRow | undefined;
  for (let round = 0; round < 2 && !a; round++) {
    const { data, error } = await player.rpc("start_payment_attempt", { p_payment: paymentId, p_request: requestKey });
    if (!error) { a = (Array.isArray(data) ? data[0] : data) as AttemptRow | undefined; break; }
    if (error.message !== "attempt_in_progress") {
      const code = paymentCode(error, "payment_start_failed");
      if (code === "payment_start_failed") await report("paymentStart", "payment", { code: error.code });
      return fail(code, STATUS[code] ?? 500);
    }
    // Another attempt of this payment is unresolved. The database has already checked the payment is this player's.
    // Ask the provider about it: if it has ended, this tap may start the next attempt (one more round).
    const { data: open } = await admin.from("payment_attempts").select("id, status, session_url, outcome, provider, created_at")
      .eq("payment_id", paymentId).in("status", UNRESOLVED).order("attempt_no", { ascending: false }).limit(1).maybeSingle();
    if (!open) continue;                                                  // it ended meanwhile
    const now = open.provider === provider.name ? await settle(admin, provider, open.id, open.created_at) : (open as Unresolved);
    if (now && UNRESOLVED.includes(now.status)) return answerFor(now);   // still live: its page, or "in progress"
    if (now?.status === "succeeded") return answerFor(now);              // it had been paid
    // failed or expired: loop once more and start the next attempt
  }
  if (!a) return fail("payment_in_progress", 409);

  // The same tap again: never call the provider a second time for one attempt.
  if (a.already) {
    let row: Unresolved | null = { id: a.attempt_id, status: a.status, session_url: a.session_url, outcome: null };
    for (let i = 0; i < 6 && row?.status === "starting"; i++) {       // the first request may still be talking to the provider
      await sleep(500);
      row = await readAttempt(admin, a.attempt_id);
    }
    if (row?.status === "starting") row = await settle(admin, provider, a.attempt_id);   // its start timed out: ask the provider
    else if (row && row.status !== "open") row = await readAttempt(admin, a.attempt_id);
    return row ? answerFor(row) : fail("payment_in_progress", 409);
  }

  const attempt = a;
  const abandon = async (why: string) => { await admin.rpc("abandon_payment_attempt", { p_attempt: attempt.attempt_id, p_note: why }); };
  if (attempt.provider !== provider.name) { await abandon("provider not configured on this deployment"); return fail("payments_not_configured", 503); }

  if (!d.origin && provider.name !== "simulated") { await abandon("PAYMENT_SITE_URL not configured"); return fail("payments_not_configured", 503); }
  const base = d.origin ?? "http://localhost";   // simulated: the URLs are never used

  let started;
  try {
    started = await provider.startAttempt({
      attemptId: attempt.attempt_id, amountUsd: Number(attempt.amount_usd), currency: "USD", description: "CourtBook booking fee",
      returnUrl: d.returnUrl(base, attempt.attempt_id), callbackUrl: providerCallbackUrl(base, provider.name),
    });
  } catch (e) {
    if (e instanceof PaymentStartRefused) {
      await abandon("provider refused to start");
      return fail("gateway_error", 502, { attemptsLeft: 3 - attempt.attempt_no });
    }
    // Unknown outcome (timeout, dropped connection, server error): the provider may have created the payment. The
    // attempt stays 'starting' — the sweeper, the callback, the return page and the next tap all ask the provider.
    await report("paymentProvider", "payment", { code: "start_unknown" });
    return fail("payment_uncertain", 502);
  }

  if (started.kind === "immediate") {
    if (provider.name !== "simulated") {
      // a real provider claiming instant money: not trusted, not dropped — left for attemptStatus to settle
      await report("paymentProvider", "payment", { code: "unexpected_immediate" });
      return fail("payment_uncertain", 502);
    }
    const r = await recordEvidence(admin, attempt.attempt_id, started.evidence);
    if (!r.ok) { await report("paymentRecord", "payment", { code: r.code }); return fail("payment_record_failed", 500); }
    return ok({ attempt: attempt.attempt_id, outcome: r.outcome });
  }

  if (!isSafeRedirect(started.url)) { await abandon("unsafe payment page url"); return fail("gateway_error", 502); }
  const { error: openError } = await admin.rpc("open_payment_attempt", { p_attempt: attempt.attempt_id, p_session_url: started.url, p_provider_session: started.session });
  if (openError) {
    // the page exists at the provider but is not stored: the attempt stays 'starting' and is settled by asking
    await report("paymentStart", "payment", { code: openError.code });
    return fail("payment_uncertain", 502);
  }
  return ok({ redirect: started.url });
}

/**
 * Where a fee payment stands, after asking the provider about an unresolved attempt (M12.4 "Check payment"). The
 * player's own client reads the rows (row-level security: someone else's payment is simply not found); only the
 * provider question and the money record use the service role, and only after ownership is established. Ownership
 * is the payment's profile_id, not row-level security alone (staff and admins can read other people's payments).
 *
 * state:
 *   confirmed        the booking is confirmed (the fee was paid)
 *   awaiting_payment the hold is live and no attempt is unresolved: the player may pay (if tries are left)
 *   payment_open     an attempt's payment page is open at the provider
 *   checking         an attempt's outcome is not known yet (its start timed out, or the provider cannot say yet)
 *   hold_expired     the hold ended and no money arrived
 *   refund_due       money arrived but no booking came of it: it is owed back
 *   cancelled        the booking was cancelled
 * A state that is not one of these is not answered as anything paid.
 *
 * If any of the reads fails (the payment, its attempts, the refunds owed), the answer is 503
 * `payment_status_unavailable` (not final): no state, no counts — never "nothing tried" or "nothing owed".
 */
export async function feePaymentStatus(d: Pick<FlowDeps, "player" | "admin" | "provider"> & { userId: string }, input: { paymentId: unknown }): Promise<FlowResult> {
  const { paymentId } = input;
  if (!isUuid(paymentId)) return fail("bad_request", 400);
  if (!isUuid(d.userId)) return fail("not_authenticated", 401);
  const { player, admin, provider } = d;
  const readMine = async () => {
    const { data, error } = await player.from("payments").select("id, kind, status, booking_id, bookings!inner(status, hold_expires_at)")
      .eq("id", paymentId).eq("profile_id", d.userId).maybeSingle();   // the player's own: club staff may read a club's payments, not ask about them here
    return { data: data as { id: string; kind: string; status: string; booking_id: string; bookings: { status: string; hold_expires_at: string | null } } | null, error };
  };
  // Fail closed (review of PR #37): a read that fails is never taken as "no attempts" or "no refund owed". The answer
  // is then a temporary error that says nothing about success, failure or refunds; the app keeps its key and asks again.
  const unavailable = async (what: string, code?: string) => {
    await report("paymentLookup", "payment", { code: code ?? what });
    return fail("payment_status_unavailable", 503);
  };
  let mine = await readMine();
  if (mine.error) return unavailable("payment", mine.error.code);
  if (!mine.data) return fail("not_found", 404);                              // not this player's (or does not exist)
  if (mine.data.kind !== "fee_only") return fail("wrong_payment_mode", 409);

  type AttemptRead = { id: string; status: string; outcome: string | null; attempt_no: number; provider: string; created_at: string };
  const attemptsOf = async (): Promise<{ rows: AttemptRead[] } | { error: string }> => {
    const { data, error } = await player.from("payment_attempts").select("id, status, outcome, attempt_no, provider, created_at").eq("payment_id", paymentId).order("attempt_no", { ascending: false });
    if (error || !Array.isArray(data)) return { error: error?.code ?? "attempts" };
    return { rows: data as AttemptRead[] };
  };
  let read = await attemptsOf();
  if ("error" in read) return unavailable("attempts", read.error);
  const open = read.rows.find((x) => UNRESOLVED.includes(x.status));
  if (open && open.provider === provider.name) {
    await settle(admin, provider, open.id, open.created_at);
    mine = await readMine();
    if (mine.error) return unavailable("payment", mine.error.code);
    if (!mine.data) return fail("not_found", 404);
    read = await attemptsOf();
    if ("error" in read) return unavailable("attempts", read.error);
  }
  const attempts = read.rows;
  const p = mine.data!;
  const b = p.bookings;
  const latest = attempts[0] ?? null;
  const unresolved = attempts.find((x) => UNRESOLVED.includes(x.status)) ?? null;
  // refund obligations on this payment (charges are admin-only: counted here for the owner, nothing else returned)
  const charges = await admin.from("fee_charges").select("id", { count: "exact", head: true }).eq("payment_id", p.id).eq("disposition", "refund_due");
  if (charges.error || typeof charges.count !== "number") return unavailable("charges", charges.error?.code);
  const refundsDue = charges.count;
  const holdLive = b.status === "pending" && !!b.hold_expires_at && Date.parse(b.hold_expires_at) > Date.now();

  const state =
    b.status === "confirmed" ? "confirmed"
    : b.status === "pending" && unresolved?.status === "open" ? "payment_open"
    : unresolved ? "checking"                       // outcome unknown — also after the hold ended: money may still arrive (then owed back)
    : b.status === "pending" && holdLive ? "awaiting_payment"
    : refundsDue > 0 || p.status === "refund_due" ? "refund_due"
    : b.status === "cancelled" ? "cancelled"
    : "hold_expired";
  return ok({
    state,
    bookingStatus: b.status,
    paymentStatus: p.status,
    holdExpiresAt: b.hold_expires_at,
    attempt: latest ? { status: latest.status, outcome: latest.outcome, attemptNo: latest.attempt_no } : null,
    attemptsLeft: Math.max(0, 3 - attempts.length),
    refundsDue,
  });
}
