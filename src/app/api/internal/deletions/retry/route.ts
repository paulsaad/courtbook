import { NextResponse } from "next/server";
import { processDeletion, serviceDeps, type Outcome } from "@/lib/deletion/pipeline";
import { bearerMatches } from "@/lib/deletion/request";
import { report } from "@/lib/report";

/**
 * M2 (0086), R1: continues closed accounts whose processing is due (app closures, and website runs that failed part
 * way). Meant to be called on a schedule; NO SCHEDULE IS CONFIGURED (activation is a separate approval, see
 * docs/m2-deletion-retry-activation.md). Until then an admin's Retry on /admin/deletions does the same for one record.
 *
 * Caller: "Authorization: Bearer <CRON_SECRET>". With no CRON_SECRET (or one shorter than 32 characters) the route
 * answers 503 and does nothing. Takes no input: what to process comes from the database (deletions_due), never from
 * the request. Each record is leased, so overlapping calls cannot process the same record twice.
 *
 * Then raises one alert per record that needs a person (held, or not finished after an hour or 3 runs): a fixed
 * message with the reason as a code; no account id. R2 (the Sentry rule that emails it) is a proposal only.
 * Answers counts only.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUDGET_MS = 40_000;   // stop starting new records after this; the rest are picked up next time
const BATCH = 20;
const ALERTS = 10;          // alerts per run (each waits up to 2 s for Sentry); the rest are raised next run

async function run(request: Request) {
  const auth = bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "unset") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "no") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const deps = await serviceDeps();
  const due = await deps.rpc("deletions_due", { p_limit: BATCH });
  if (due.error) {
    await report("deletionStepFailed", "account", { code: due.error.code ?? "due_list" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
  const subjects = (Array.isArray(due.data) ? due.data : []).filter((s): s is string => typeof s === "string");

  const counts: Record<Outcome["result"], number> = { done: 0, held: 0, skipped: 0, failed: 0, lease_lost: 0 };
  const started = Date.now();
  let processed = 0;
  for (const subject of subjects) {
    if (Date.now() - started > BUDGET_MS) break;
    try { counts[(await processDeletion(subject, deps)).result]++; } catch { counts.failed++; }
    processed++;
  }

  let alerts = 0;
  const attention = await deps.rpc("deletions_needing_attention", {});
  if (!attention.error && Array.isArray(attention.data)) {
    for (const row of (attention.data as Array<{ subject_id?: unknown; reason?: unknown }>).slice(0, ALERTS)) {
      if (typeof row?.subject_id !== "string") continue;
      if (Date.now() - started > BUDGET_MS + 10_000) break;   // stay well inside maxDuration
      await report("deletionNeedsAttention", "account", { code: row.reason === "held" ? "held" : "stuck" });
      const m = await deps.rpc("mark_deletion_alerted", { p_subject: row.subject_id });
      if (!m.error) alerts++;
    }
  }
  return NextResponse.json({ ...counts, remaining: subjects.length - processed, alerts });
}

export const GET = run;    // Vercel Cron calls GET
export const POST = run;
