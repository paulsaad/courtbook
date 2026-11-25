import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { playerFromBearer } from "@/lib/supabase/bearer";
import { getProvider } from "@/lib/payments";
import { isUuid } from "@/lib/payments/urls";
import { fail, feePaymentStatus } from "@/lib/payments/startFlow";
import { nativePaymentsEnabled } from "@/lib/payments/native";

/**
 * Where the player's own booking-fee payment stands (M12.4), after asking the provider about an unresolved attempt.
 * The app calls this on return from the payment page, on "Check payment", and when it reopens. It never starts or
 * retries a payment. Someone else's payment is answered exactly like one that does not exist (404 not_found).
 */
const answer = (r: { status: number; body: Record<string, unknown> }) =>
  NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (!nativePaymentsEnabled()) return answer(fail("payments_not_configured", 503));
  const body = (await request.json().catch(() => ({}))) as { paymentId?: unknown } | null;
  if (!body || !isUuid(body.paymentId)) return answer(fail("bad_request", 400));

  const who = await playerFromBearer(request);
  if (!who) return answer(fail("not_authenticated", 401));

  return answer(await feePaymentStatus(
    { player: who.player, admin: createAdminClient(), provider: getProvider(), userId: who.userId },
    { paymentId: body.paymentId },
  ));
}
