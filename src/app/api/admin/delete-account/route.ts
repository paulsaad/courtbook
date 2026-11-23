import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { processDeletion, serviceDeps, dbCode, type Outcome } from "@/lib/deletion/pipeline";
import { sameSiteJson, jsonBody, UUID } from "@/lib/deletion/request";

/**
 * M2 (0086): the admin's manual recovery on /admin/deletions (D4 fallback). Same pipeline as the website and the
 * retry route; no "force": every refusal rule still applies.
 *
 *   { subject, action: "retry" }    run the pipeline for one closed account now (ignores the backoff, not the lease)
 *   { subject, action: "release" }  a held account whose hold is lifted: release_held_deletion runs AS THE ADMIN (the
 *                                   database checks is_admin and the refusal rules again), then the pipeline
 *
 * Who: a signed-in admin (is_admin, asked of the database with the admin's own session), never for their own account,
 * from a page of this site. Only then does the pipeline run with the service key. Answers codes only.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (!sameSiteJson(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await jsonBody(request);
  const subject = body?.subject, action = body?.action;
  if (typeof subject !== "string" || !UUID.test(subject) || (action !== "retry" && action !== "release")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (user.id === subject) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const admin = await supabase.rpc("is_admin");
  if (admin.error || admin.data !== true) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (action === "release") {
    const r = await supabase.rpc("release_held_deletion", { p_subject: subject });
    if (r.error) return NextResponse.json({ error: dbCode(r.error), step: "release" }, { status: 409 });
  }

  let outcome: Outcome;
  try { outcome = await processDeletion(subject, await serviceDeps()); }
  catch { outcome = { result: "failed", step: "claim", code: "exception" }; }   // e.g. network; a release above has committed
  return NextResponse.json({ ok: outcome.result !== "failed" && outcome.result !== "lease_lost", outcome, released: action === "release" });
}
