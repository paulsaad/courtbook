import { NextResponse } from "next/server";
import { PRIVACY_PROBE, SAFE_MESSAGES } from "@/lib/monitoring";
import { isAdmin, testErrorsAllowed } from "@/lib/monitoringTest";

/** Staging only (404 on production): throws a server error so the monitoring can be checked end to end.
 *  ?kind=server  a fixed test message, which must arrive as is;
 *  ?kind=probe   a message full of fake personal data, which must arrive as "[withheld]". */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!testErrorsAllowed() || !(await isAdmin())) return new NextResponse(null, { status: 404 });
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind === "probe") throw new Error(PRIVACY_PROBE);
  throw new Error(SAFE_MESSAGES.testServer);
}
