import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { playerFromBearer } from "@/lib/supabase/bearer";
import { getProvider } from "@/lib/payments";
import { appReturnUrl, isUuid, paymentSiteOrigin } from "@/lib/payments/urls";
import { fail, startFeePayment } from "@/lib/payments/startFlow";
import { nativePaymentsEnabled } from "@/lib/payments/native";

/**
 * Pay the CourtBook booking fee from the app (M12.4). Same rules and same code as the website's /api/pay/start
 * (startFeePayment); only who the player is differs: the Supabase access token in the Authorization header, checked
 * with Supabase Auth. The provider returns the player to /pay/app-return, which carries nothing and proves nothing:
 * the app then asks /api/native/pay/status.
 *
 * Off unless NATIVE_PAYMENTS=1 on this deployment (answers 503 payments_not_configured, final).
 */
const answer = (r: { status: number; body: Record<string, unknown> }) =>
  NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (!nativePaymentsEnabled()) return answer(fail("payments_not_configured", 503));
  const body = (await request.json().catch(() => ({}))) as { paymentId?: unknown; requestKey?: unknown } | null;
  if (!body || !isUuid(body.paymentId) || !isUuid(body.requestKey)) return answer(fail("bad_request", 400));

  const who = await playerFromBearer(request);
  if (!who) return answer(fail("not_authenticated", 401));

  return answer(await startFeePayment(
    { player: who.player, admin: createAdminClient(), provider: getProvider(), origin: paymentSiteOrigin(), returnUrl: appReturnUrl },
    { paymentId: body.paymentId, requestKey: body.requestKey },
  ));
}
