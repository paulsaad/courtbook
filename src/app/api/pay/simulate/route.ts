import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { report } from "@/lib/report";
import { getProvider } from "@/lib/payments";
import { paymentCode } from "@/lib/payments/attempts";
import { isUuid, paymentSiteOrigin } from "@/lib/payments/urls";

/**
 * Start (or resume) payment for a pending payment the caller owns.
 * - Eligibility: payment pending AND booking pending (hold still live). Otherwise 409.
 * - Session reuse: one gateway session per payment. claim_payment_session() lets exactly one request
 *   call the gateway; concurrent requests wait for the stored session_url. Providers must also pass
 *   paymentId as their idempotency key where the gateway supports it.
 * - Only the simulated provider may confirm "immediately"; any real provider confirms through
 *   its callback/verify route with independently verified evidence.
 * - Model 1 only (court + fee online, demo clubs). A fee-only payment (fee_online clubs, M12.1) is paid through
 *   /api/pay/start, by attempts; confirm_payment refuses it anyway.
 * - M12.1 review fixes: no database text and no user or payment id is returned or logged; return URLs come from
 *   PAYMENT_SITE_URL, never from this request's host.
 */
export async function POST(request: Request) {
  const { paymentId } = (await request.json().catch(() => ({}))) as { paymentId?: string };
  if (!isUuid(paymentId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const { data: payment, error: lookupError } = await supabase
    .from("payments")
    .select("id, total_usd, status, provider, kind, session_ref, session_url, bookings!inner(status, hold_expires_at)")
    .eq("id", paymentId)
    .eq("profile_id", user.id)
    .single();
  if (!payment) {
    // an RLS or privilege problem looks like "not found": it is reported by its code only, never with ids or text
    if (lookupError && lookupError.code !== "PGRST116") await report("paymentLookup", "payment", { code: lookupError.code });
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (payment.kind === "fee_only") return NextResponse.json({ error: "use_payment_attempts" }, { status: 409 });
  const booking = payment.bookings as unknown as { status: string; hold_expires_at: string | null };
  if (payment.status !== "pending" || booking.status !== "pending") {
    return NextResponse.json({ error: "not_payable" }, { status: 409 });
  }

  const provider = getProvider();
  if (payment.provider !== provider.name) return NextResponse.json({ error: "wrong_provider" }, { status: 400 });

  // resume an existing gateway session
  if (payment.session_url) return NextResponse.json({ redirect: payment.session_url });

  const admin = createAdminClient();
  const origin = paymentSiteOrigin();

  if (provider.name !== "simulated") {
    if (!origin) return NextResponse.json({ error: "payments_not_configured" }, { status: 503 });
    // exactly one request may call the gateway: atomic claim in the DB
    const { data: claimed } = await admin.rpc("claim_payment_session", { p_payment: payment.id });
    if (!claimed) {
      // another request is creating the session: wait for its URL
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const { data: row } = await admin.from("payments").select("session_url").eq("id", payment.id).single();
        if (row?.session_url) return NextResponse.json({ redirect: row.session_url });
      }
      return NextResponse.json({ error: "session_in_progress" }, { status: 409 });
    }
    try {
      const started = await provider.start({
        paymentId: payment.id, totalUsd: Number(payment.total_usd), currency: "USD", description: "CourtBook court booking",
        returnUrl: `${origin}/pay/return?payment=${payment.id}`, failUrl: `${origin}/pay/return?payment=${payment.id}&failed=1`,
      });
      if (started.kind !== "redirect") throw new Error("provider_requires_verification");
      await admin.from("payments").update({ session_ref: started.sessionRef, session_url: started.url }).eq("id", payment.id);
      return NextResponse.json({ redirect: started.url });
    } catch {
      await admin.rpc("release_payment_session_claim", { p_payment: payment.id });
      await report("paymentProvider", "payment", { code: "start" });
      return NextResponse.json({ error: "gateway_error" }, { status: 502 });
    }
  }

  // simulated: no gateway, no session, no URL used; confirm server-side with the DB amount
  const started = await provider.start({
    paymentId: payment.id, totalUsd: Number(payment.total_usd), currency: "USD", description: "CourtBook court booking",
    returnUrl: "", failUrl: "",
  });
  if (started.kind !== "immediate") return NextResponse.json({ error: "unexpected_provider_result" }, { status: 500 });

  const { data, error } = await admin.rpc("confirm_payment", {
    p_payment: payment.id,
    p_provider_ref: started.providerRef,
    p_total_usd: payment.total_usd,
  });
  if (error) {
    const code = paymentCode(error, "payment_failed");
    if (code === "payment_failed") await report("paymentLookup", "payment", { code: error.code });
    return NextResponse.json({ error: code }, { status: 409 });
  }
  return NextResponse.json({ outcome: data as string });
}
