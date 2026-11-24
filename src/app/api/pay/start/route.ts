import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { report } from "@/lib/report";
import { getProvider } from "@/lib/payments";
import { paymentCode, recordEvidence } from "@/lib/payments/attempts";
import { attemptReturnUrl, isSafeRedirect, isUuid, paymentSiteOrigin, providerCallbackUrl } from "@/lib/payments/urls";

/**
 * Pay the CourtBook booking fee (fee_online clubs, M12.1). One call = one attempt with the provider.
 *
 * - The browser sends the payment and a request key it made for this tap; a retry of the same tap sends the same key
 *   and gets the same attempt (start_payment_attempt, 0093). At most three attempts per hold; the hold's deadline is
 *   never moved.
 * - The database decides eligibility as the signed-in player (it checks the payment is theirs and still payable).
 * - Return and callback URLs come from PAYMENT_SITE_URL, never from this request's host.
 * - Answers carry fixed codes only; nothing about the database or the provider's text is returned or logged.
 */
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });

const STATUS: Record<string, number> = {
  not_authenticated: 401, not_found: 404, token_required: 400, wrong_payment_mode: 409, not_payable: 409,
  hold_expired: 409, attempts_exhausted: 409, payments_not_configured: 503,
};

type AttemptRow = { attempt_id: string; attempt_no: number; provider: string; amount_usd: number | string; currency: string; status: string; session_url: string | null; already: boolean };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { paymentId?: unknown; requestKey?: unknown };
  if (!isUuid(body.paymentId) || !isUuid(body.requestKey)) return json({ error: "bad_request" }, 400);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "not_authenticated" }, 401);

  const { data, error } = await supabase.rpc("start_payment_attempt", { p_payment: body.paymentId, p_request: body.requestKey });
  if (error) {
    const code = paymentCode(error, "payment_start_failed");
    if (code === "payment_start_failed") await report("paymentStart", "payment", { code: error.code });
    return json({ error: code }, STATUS[code] ?? 500);
  }
  const a = (Array.isArray(data) ? data[0] : data) as AttemptRow | undefined;
  if (!a) { await report("paymentStart", "payment", { code: "no_row" }); return json({ error: "payment_start_failed" }, 500); }

  const admin = createAdminClient();

  // The same tap again: answer with what the first one got, never call the provider a second time for one attempt.
  if (a.already) {
    for (let i = 0; i < 6 && a.status === "starting" && !a.session_url; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data: row } = await admin.from("payment_attempts").select("status, session_url").eq("id", a.attempt_id).single();
      if (row) { a.status = row.status; a.session_url = row.session_url; }
    }
    if (a.status === "open" && a.session_url) return json({ redirect: a.session_url });
    if (a.status === "starting") return json({ error: "payment_in_progress" }, 409);
    return json({ attempt: a.attempt_id, state: a.status });
  }

  const provider = getProvider();
  const abandon = async (why: string) => { await admin.rpc("abandon_payment_attempt", { p_attempt: a.attempt_id, p_note: why }); };
  if (a.provider !== provider.name) { await abandon("provider not configured on this deployment"); return json({ error: "payments_not_configured" }, 503); }

  const origin = paymentSiteOrigin();
  if (!origin && provider.name !== "simulated") { await abandon("PAYMENT_SITE_URL not configured"); return json({ error: "payments_not_configured" }, 503); }
  const base = origin ?? "http://localhost";   // simulated: the URLs are never used

  let started;
  try {
    started = await provider.startAttempt({
      attemptId: a.attempt_id, amountUsd: Number(a.amount_usd), currency: "USD", description: "CourtBook booking fee",
      returnUrl: attemptReturnUrl(base, a.attempt_id), callbackUrl: providerCallbackUrl(base, provider.name),
    });
  } catch {
    await abandon("provider refused to start");
    await report("paymentProvider", "payment", { code: "start" });
    return json({ error: "gateway_error", attemptsLeft: 3 - a.attempt_no }, 502);
  }

  if (started.kind === "immediate") {
    if (provider.name !== "simulated") { await abandon("unexpected immediate result"); return json({ error: "gateway_error" }, 502); }
    const r = await recordEvidence(admin, a.attempt_id, started.evidence);
    if (!r.ok) { await report("paymentRecord", "payment", { code: r.code }); return json({ error: "payment_record_failed" }, 500); }
    return json({ attempt: a.attempt_id, outcome: r.outcome });
  }

  if (!isSafeRedirect(started.url)) { await abandon("unsafe payment page url"); return json({ error: "gateway_error" }, 502); }
  const { error: openError } = await admin.rpc("open_payment_attempt", { p_attempt: a.attempt_id, p_session_url: started.url, p_provider_session: started.session });
  if (openError) { await report("paymentStart", "payment", { code: openError.code }); return json({ error: "payment_start_failed" }, 500); }
  return json({ redirect: started.url });
}
