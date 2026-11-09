import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProvider } from "@/lib/payments";

/**
 * Start (or resume) payment for a pending payment the caller owns.
 * - Eligibility: payment pending AND booking pending (hold still live). Otherwise 409.
 * - Session reuse: if a gateway session was already created for this payment, return it again;
 *   never open a second one (payments.session_ref / session_url, written with the service role).
 * - Only the simulated provider may confirm "immediately"; any real provider confirms through
 *   its callback/verify route with independently verified evidence.
 */
export async function POST(request: Request) {
  const { paymentId } = (await request.json().catch(() => ({}))) as { paymentId?: string };
  if (!paymentId) return NextResponse.json({ error: "paymentId required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const { data: payment } = await supabase
    .from("payments")
    .select("id, total_usd, status, provider, session_ref, session_url, bookings!inner(status, hold_expires_at)")
    .eq("id", paymentId)
    .eq("profile_id", user.id)
    .single();
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const booking = payment.bookings as unknown as { status: string; hold_expires_at: string | null };
  if (payment.status !== "pending" || booking.status !== "pending") {
    return NextResponse.json({ error: "not_payable", status: payment.status, booking: booking.status }, { status: 409 });
  }

  const provider = getProvider();
  if (payment.provider !== provider.name) return NextResponse.json({ error: "wrong_provider" }, { status: 400 });

  // resume an existing gateway session
  if (payment.session_url) return NextResponse.json({ redirect: payment.session_url });

  const origin = new URL(request.url).origin;
  const started = await provider.start({
    paymentId: payment.id,
    totalUsd: Number(payment.total_usd),
    currency: "USD",
    description: "CourtBook court booking",
    returnUrl: `${origin}/pay/return?payment=${payment.id}`,
    failUrl: `${origin}/pay/return?payment=${payment.id}&failed=1`,
  });

  const admin = createAdminClient();

  if (started.kind === "redirect") {
    // persist the session so a second click reuses it; first writer wins
    await admin.from("payments").update({ session_ref: started.sessionRef, session_url: started.url }).eq("id", payment.id).is("session_url", null);
    const { data: fresh } = await admin.from("payments").select("session_url").eq("id", payment.id).single();
    return NextResponse.json({ redirect: fresh?.session_url ?? started.url });
  }

  // immediate confirmation is a simulated-provider privilege
  if (provider.name !== "simulated") return NextResponse.json({ error: "provider_requires_verification" }, { status: 500 });

  const { data, error } = await admin.rpc("confirm_payment", {
    p_payment: payment.id,
    p_provider_ref: started.providerRef,
    p_total_usd: payment.total_usd,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ outcome: data as string });
}
