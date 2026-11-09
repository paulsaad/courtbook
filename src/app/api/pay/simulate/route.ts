import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Simulated payment provider (Milestone A). The browser only says "pay this payment id";
 * the server verifies the caller owns it, then confirms through the service role.
 * A real provider replaces this route with a redirect + a server-side verification/callback.
 */
export async function POST(request: Request) {
  const { paymentId } = (await request.json().catch(() => ({}))) as { paymentId?: string };
  if (!paymentId) return NextResponse.json({ error: "paymentId required" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  // RLS: the user can only see their own payments
  const { data: payment } = await supabase
    .from("payments")
    .select("id, total_usd, status, provider")
    .eq("id", paymentId)
    .eq("profile_id", user.id)
    .single();
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (payment.provider !== "simulated") return NextResponse.json({ error: "wrong_provider" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("confirm_payment", {
    p_payment: payment.id,
    p_provider_ref: `SIM-${payment.id.slice(0, 8)}`,
    p_total_usd: payment.total_usd,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ outcome: data as string });
}
