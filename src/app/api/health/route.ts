import { NextResponse } from "next/server";
import { databaseReachable } from "@/lib/health";

/** Health check for the uptime monitor (W2a, alert A4): 200 when the site runs and the database answers, 503
 *  otherwise. The body is only {"ok": true|false}: nothing about why, nothing about the setup. Never cached. */
export const dynamic = "force-dynamic";

export async function GET() {
  const ok = await databaseReachable();
  return NextResponse.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
