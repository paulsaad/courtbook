import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { report } from "@/lib/report";
import { getProvider } from "@/lib/payments";
import { PaymentStartRefused } from "@/lib/payments/provider";
import { paymentCode, recordEvidence, verifyAndRecord } from "@/lib/payments/attempts";
import { attemptReturnUrl, isSafeRedirect, isUuid, paymentSiteOrigin, providerCallbackUrl } from "@/lib/payments/urls";

/**
 * Pay the CourtBook booking fee (fee_online clubs, M12.1). One tap = one attempt with the provider.
 *
 * - The browser sends the payment and a request key it made for this tap, and keeps the key until the outcome is
 *   known; a retry of the same tap gets the same attempt (start_payment_attempt, 0093). At most three attempts per
 *   hold; the hold's deadline is never moved.
 * - Only one attempt may be unresolved at a time (review of PR #34). A tap while another attempt is still 'starting'
 *   or 'open' makes the server ask the provider about that attempt first; only if it has ended may a new one start.
 * - A provider that times out has not refused: the attempt stays unresolved ('starting') and is settled by asking the
 *   provider (this route on the next tap, the return page, the callback or the sweeper). Only PaymentStartRefused
 *   ends it.
 * - Return and callback URLs come from PAYMENT_SITE_URL, never from this request's host.
 * - Answers carry fixed codes only; nothing about the database or the provider's text is returned or logged.
 *
 * Answers: { redirect } | { attempt, outcome } (finished) | { attempt, state } | { error, final }. `final: false`
 * means the outcome is not known yet: the browser keeps its request key and retries with it.
 */
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });
/** No attempt is unresolved after these: the browser may forget its key. */
const FINAL = new Set(["bad_request", "not_authenticated", "not_found", "token_required", "wrong_payment_mode", "not_payable",
  "hold_expired", "attempts_exhausted", "payments_not_configured", "gateway_error"]);
const fail = (error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, final: FINAL.has(error), ...extra }, status);

const STATUS: Record<string, number> = {
  not_authenticated: 401, not_found: 404, token_required: 400, wrong_payment_mode: 409, not_payable: 409,
  hold_expired: 409, attempts_exhausted: 409, payments_not_configured: 503, attempt_in_progress: 409,
};

type AttemptRow = { attempt_id: string; attempt_no: number; provider: string; amount_usd: number | string; currency: string; status: string; session_url: string | null; already: boolean };
type Admin = ReturnType<typeof createAdminClient>;
type Unresolved = { id: string; status: string; session_url: string | null; outcome: string | null };

const UNRESOLVED = ["starting", "open"];

async function readAttempt(admin: Admin, id: string): Promise<Unresolved | null> {
  const { data } = await admin.from("payment_attempts").select("id, status, session_url, outcome").eq("id", id).single();
  return (data as Unresolved | null) ?? null;
}

/** Ask the provider about an unresolved attempt and record its answer; then what the attempt is now. */
async function settle(admin: Admin, attemptId: string): Promise<Unresolved | null> {
  const provider = getProvider();
  const r = await verifyAndRecord(admin, provider, attemptId);
  if (!r.ok) await report(r.code === "provider_unavailable" ? "paymentProvider" : "paymentRecord", "payment", { code: r.code });
  return readAttempt(admin, attemptId);
}

/** What to tell the browser about an attempt that already exists. */
function answerFor(a: Unresolved) {
  if (a.status === "open" && a.session_url) return json({ redirect: a.session_url });
  if (UNRESOLVED.includes(a.status)) return fail("payment_in_progress", 409);   // starting, or open with no usable page
  if (a.status === "succeeded") return json({ attempt: a.id, outcome: a.outcome });
  return json({ attempt: a.id, state: a.status });                     // failed / expired: this tap is over
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { paymentId?: unknown; requestKey?: unknown };
  if (!isUuid(body.paymentId) || !isUuid(body.requestKey)) return fail("bad_request", 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail("not_authenticated", 401);
  const admin = createAdminClient();

  let a: AttemptRow | undefined;
  for (let round = 0; round < 2 && !a; round++) {
    const { data, error } = await supabase.rpc("start_payment_attempt", { p_payment: body.paymentId, p_request: body.requestKey });
    if (!error) { a = (Array.isArray(data) ? data[0] : data) as AttemptRow | undefined; break; }
    if (error.message !== "attempt_in_progress") {
      const code = paymentCode(error, "payment_start_failed");
      if (code === "payment_start_failed") await report("paymentStart", "payment", { code: error.code });
      return fail(code, STATUS[code] ?? 500);
    }
    // Another attempt of this payment is unresolved. The database has already checked the payment is this player's.
    // Ask the provider about it: if it has ended, this tap may start the next attempt (one more round).
    const { data: open } = await admin.from("payment_attempts").select("id, status, session_url, outcome, provider")
      .eq("payment_id", body.paymentId).in("status", UNRESOLVED).order("attempt_no", { ascending: false }).limit(1).maybeSingle();
    if (!open) continue;                                                  // it ended meanwhile
    const now = open.provider === getProvider().name ? await settle(admin, open.id) : (open as Unresolved);
    if (now && UNRESOLVED.includes(now.status)) return answerFor(now);   // still live: its page, or "in progress"
    if (now?.status === "succeeded") return answerFor(now);              // it had been paid
    // failed or expired: loop once more and start the next attempt
  }
  if (!a) return fail("payment_in_progress", 409);

  // The same tap again: never call the provider a second time for one attempt.
  if (a.already) {
    let row: Unresolved | null = { id: a.attempt_id, status: a.status, session_url: a.session_url, outcome: null };
    for (let i = 0; i < 6 && row?.status === "starting"; i++) {       // the first request may still be talking to the provider
      await new Promise((r) => setTimeout(r, 500));
      row = await readAttempt(admin, a.attempt_id);
    }
    if (row?.status === "starting") row = await settle(admin, a.attempt_id);   // its start timed out: ask the provider
    else if (row && row.status !== "open") row = await readAttempt(admin, a.attempt_id);
    return row ? answerFor(row) : fail("payment_in_progress", 409);
  }

  const provider = getProvider();
  const abandon = async (why: string) => { await admin.rpc("abandon_payment_attempt", { p_attempt: a.attempt_id, p_note: why }); };
  if (a.provider !== provider.name) { await abandon("provider not configured on this deployment"); return fail("payments_not_configured", 503); }

  const origin = paymentSiteOrigin();
  if (!origin && provider.name !== "simulated") { await abandon("PAYMENT_SITE_URL not configured"); return fail("payments_not_configured", 503); }
  const base = origin ?? "http://localhost";   // simulated: the URLs are never used

  let started;
  try {
    started = await provider.startAttempt({
      attemptId: a.attempt_id, amountUsd: Number(a.amount_usd), currency: "USD", description: "CourtBook booking fee",
      returnUrl: attemptReturnUrl(base, a.attempt_id), callbackUrl: providerCallbackUrl(base, provider.name),
    });
  } catch (e) {
    if (e instanceof PaymentStartRefused) {
      await abandon("provider refused to start");
      return fail("gateway_error", 502, { attemptsLeft: 3 - a.attempt_no });
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
    const r = await recordEvidence(admin, a.attempt_id, started.evidence);
    if (!r.ok) { await report("paymentRecord", "payment", { code: r.code }); return fail("payment_record_failed", 500); }
    return json({ attempt: a.attempt_id, outcome: r.outcome });
  }

  if (!isSafeRedirect(started.url)) { await abandon("unsafe payment page url"); return fail("gateway_error", 502); }
  const { error: openError } = await admin.rpc("open_payment_attempt", { p_attempt: a.attempt_id, p_session_url: started.url, p_provider_session: started.session });
  if (openError) {
    // the page exists at the provider but is not stored: the attempt stays 'starting' and is settled by asking
    await report("paymentStart", "payment", { code: openError.code });
    return fail("payment_uncertain", 502);
  }
  return json({ redirect: started.url });
}
