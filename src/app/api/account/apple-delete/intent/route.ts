import { NextResponse } from "next/server";
import { playerFromBearer } from "@/lib/supabase/bearer";
import { appleDeletionSetup } from "@/lib/apple/routeDeps";
import { signIntent } from "@/lib/apple/intent";

/**
 * E1 (draft, OFF): step 1 of deleting an Apple-linked account from the app. Called with the app's ORIGINAL session,
 * BEFORE the Apple sheet. Answers a deletion intent bound to that account (intent.ts); the deletion call must carry it
 * and is refused if, after Apple, the request comes from any other account (third review 25 Nov, point 1).
 *
 * Off (503 not_configured) until both the company's Sign in with Apple credentials and DELETION_INTENT_SECRET exist.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const setup = appleDeletionSetup();
  if (!setup) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const who = await playerFromBearer(request);
  if (!who) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  return NextResponse.json({ intent: signIntent(setup.secret, who.userId) }, { headers: { "cache-control": "no-store" } });
}
