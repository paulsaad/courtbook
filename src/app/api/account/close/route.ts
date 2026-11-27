import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { processDeletion, serviceDeps, dbCode } from "@/lib/deletion/pipeline";
import { sameSiteJson, jsonBody } from "@/lib/deletion/request";
import { report } from "@/lib/report";
import { revokeAllSessions } from "@/lib/signOutAll";

/**
 * M2 (0086): the website's "Delete my account". One confirmation; no undo (D1).
 *
 *   1. Only a JSON POST from a page of this site, with { confirm: true }.
 *   2. The account is the signed-in person's, taken from their own session (verified with Supabase Auth). The body
 *      never names an account.
 *   3. close_my_account runs AS THEM (A): from its commit the database refuses every write by this account.
 *      Staff and admin accounts are refused here and nothing changes. So is a session not signed in within the last
 *      10 minutes ('reauth_required'): the page then asks for an email code and tries again (review 23 Nov).
 *   4. Every session is asked to end, confirmed by the Auth server (refresh tokens revoked); this browser's cookies are
 *      cleared whatever the answer. Unconfirmed: reported; the ban in step B stops the other devices from renewing.
 *   5. The rest (B–E) runs now with the service key; if any step fails it is recorded and continues later (retry route
 *      or the admin page). The answer is the same either way: the account is closed. It never says "deleted".
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// refusals the page explains; reauth_required: signed in too long ago, the page asks for an email code (review 23 Nov)
const REFUSED = new Set(["staff_role", "admin_role", "reauth_required"]);

export async function POST(request: Request) {
  if (!sameSiteJson(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await jsonBody(request);
  if (body?.confirm !== true) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const closed = await supabase.rpc("close_my_account", { p_via: "web" });
  if (closed.error) {
    const code = dbCode(closed.error);
    if (REFUSED.has(code)) return NextResponse.json({ error: code }, { status: 409 });
    await report("accountCloseFailed", "account", { code: closed.error.code });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }

  // closed from here on, whatever happens next
  // every session of the account, on every device (F2: ordinary sign-out is this device only; closure is not).
  // Follow-up 27 Nov: confirmed by the Auth server (revokeAllSessions), not assumed: auth.signOut({ scope: "global" })
  // reported success on a 401/403/404. Not confirmed: reported, this browser is signed out anyway, and the ban (B,
  // below; or the retry route) stops every other device from renewing. Issued access tokens last until they expire;
  // the database refuses their writes from the close.
  // "ended" (this browser's session was already gone on the server) is unconfirmed too: the other sessions were not
  // asked to end from here
  const revoked = await revokeAllSessions(supabase.auth);
  if (revoked !== "revoked") {
    try { await report("deletionStepFailed", "account", { code: "global_signout" }); } catch { /* never skips the ban */ }
  }
  if (revoked === "failed") {
    try { await supabase.auth.signOut({ scope: "local" }); } catch { /* the ban (B) and the database lock-out still apply */ }
  }

  try {
    const out = await processDeletion(user.id, await serviceDeps());
    if (out.result === "failed") await report("deletionStepFailed", "account", { code: out.code });
  } catch {
    await report("deletionStepFailed", "account", { code: "exception" });
  }
  return NextResponse.json({ closed: true });
}
