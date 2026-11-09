import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProvider } from "@/lib/payments";

/**
 * Pay a pending payment through the configured provider.
 * Simulated: start() returns immediately → the server confirms with the DB amount via the service role.
 * Hosted providers: start() returns a redirect URL; confirmation then happens in the provider's
 * callback/verify route, never here. The browser only ever sends the payment id.
 */
export async function POST(request: Request) {
  const { paymentId } = (await request.json().catch(() => ({}))) as { paymentId?: string };
  if (!paymentId) return NextResponse.json({ error: "paymentId required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const { data: payment } = await supabase
    .from("payments")
    .select("id, total_usd, status, provider, currency")
    .eq("id", paymentId)
    .eq("profile_id", user.id)
    .single();
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const provider = getProvider();
  if (payment.provider !== provider.name) return NextResponse.json({ error: "wrong_provider" }, { status: 400 });

  const origin = new URL(request.url).origin;
  const started = await provider.start({
    paymentId: payment.id,
    totalUsd: Number(payment.total_usd),
    currency: "USD",
    description: "CourtBook court booking",
    returnUrl: `${origin}/pay/return?payment=${payment.id}`,
    failUrl: `${origin}/pay/return?payment=${payment.id}&failed=1`,
  });

  if (started.kind === "redirect") return NextResponse.json({ redirect: started.url });

  // immediate (simulated): confirm server-side with the amount recorded in the DB
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("confirm_payment", {
    p_payment: payment.id,
    p_provider_ref: started.providerRef,
    p_total_usd: payment.total_usd,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ outcome: data as string });
}
