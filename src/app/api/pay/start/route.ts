import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProvider } from "@/lib/payments";
import { attemptReturnUrl, isUuid, paymentSiteOrigin } from "@/lib/payments/urls";
import { fail, startFeePayment } from "@/lib/payments/startFlow";

/**
 * Pay the CourtBook booking fee from the website (fee_online clubs, M12.1). The player is the cookie session; all
 * payment rules live in startFeePayment (src/lib/payments/startFlow.ts), shared with the app's /api/native/pay/start.
 *
 * Answers: { redirect } | { attempt, outcome } (finished) | { attempt, state } | { error, final }. `final: false`
 * means the outcome is not known yet: the browser keeps its request key and retries with it.
 */
const answer = (r: { status: number; body: Record<string, unknown> }) => NextResponse.json(r.body, { status: r.status });

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { paymentId?: unknown; requestKey?: unknown };
  if (!isUuid(body.paymentId) || !isUuid(body.requestKey)) return answer(fail("bad_request", 400));

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return answer(fail("not_authenticated", 401));

  return answer(await startFeePayment(
    { player: supabase, admin: createAdminClient(), provider: getProvider(), origin: paymentSiteOrigin(), returnUrl: attemptReturnUrl },
    { paymentId: body.paymentId, requestKey: body.requestKey },
  ));
}
