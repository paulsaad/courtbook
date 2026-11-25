import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { report } from "@/lib/report";
import { providerNamed } from "@/lib/payments";
import { verifyAndRecord } from "@/lib/payments/attempts";
import { isUuid } from "@/lib/payments/urls";

/**
 * A payment provider tells us something happened to an attempt (M12.1). Its message is not believed: only WHICH
 * attempt it is about is read, then the server asks the provider itself (attemptStatus) and records that answer
 * through the same idempotent path as the return page and the sweeper. A forged or repeated callback can therefore
 * at most make us ask again.
 *
 * Callback URLs are configured (PAYMENT_SITE_URL), and a provider other than the one this deployment uses is
 * answered 404. The answer never carries details.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: name } = await params;
  const provider = providerNamed(name);
  if (!provider?.callbackAttemptId) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let attemptId: string | null = null;
  try { attemptId = await provider.callbackAttemptId(request); } catch { attemptId = null; }
  if (!isUuid(attemptId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const r = await verifyAndRecord(createAdminClient(), provider, attemptId);
  if (!r.ok) {
    // attempt_not_found: not ours (or forged) — nothing to do, and nothing to tell the caller
    if (r.code === "attempt_not_found") return NextResponse.json({ ok: true });
    await report(r.code === "provider_unavailable" ? "paymentProvider" : "paymentRecord", "payment", { code: r.code });
    return NextResponse.json({ error: "try_later" }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
