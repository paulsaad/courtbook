import { NextResponse } from "next/server";
import { processDeletion, serviceDeps, type Outcome } from "@/lib/deletion/pipeline";
import { bearerMatches } from "@/lib/deletion/request";
import { report } from "@/lib/report";
import { finishRetryCheckIn, startRetryCheckIn } from "@/lib/deletion/monitor";

/**
 * M2 (0086), R1: continues closed accounts whose processing is due (app closures, and website runs that failed part
 * way). Called by the Vercel schedule "deletion-retry" in vercel.json (GET, Authorization: Bearer CRON_SECRET). That
 * schedule is created INACTIVE on Preview branches and must be enabled per branch; enabling it is a separate approval.
 * Production gets it only through a reviewed release. An admin's Retry on /admin/deletions does the same for one record.
 *
 * Monitoring: a run that passed the bearer check sends Sentry cron check-ins (src/lib/deletion/monitor.ts): in_progress,
 * then ok (200) or error (any other status). Unauthenticated calls send none; a schedule that stops shows as missed.
 *
 * Caller: "Authorization: Bearer <CRON_SECRET>". With no CRON_SECRET (or one shorter than 32 characters) the route
 * answers 503 and does nothing. Takes no input: what to process comes from the database (deletions_due), never from
 * the request. Each record is leased, so overlapping calls cannot process the same record twice.
 *
 * First, requests made by older app versions (request-and-wait) whose 24-hour grace period has passed become closures
 * (promote_due_requests). At the end of a run that got that far, it records a heartbeat (record_deletion_worker_run):
 * the app offers one-step closing only while the heartbeat is under an hour old (review 23 Nov, finding 1).
 *
 * Then raises one alert per record that needs a person (held, or not finished after an hour or 3 runs): a fixed
 * message with the reason as a code; no account id. R2 (the Sentry rule that emails it) is a proposal only.
 * Answers counts only.
 *
 * Status (review 24 Nov, PR #31): 200 only when the whole run succeeded. If a record failed, the alert check or an
 * alert's marking failed, or the heartbeat could not be recorded, it answers 500 with the same counts plus
 * `problems` (codes only), so the scheduler shows the run as failed. The status changes nothing else: failed records
 * stay due and are retried on the next run, and the heartbeat is recorded exactly as before (a run that got past the
 * due list counts as alive; per-record failures surface as alerts and here, not by pausing the app).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUDGET_MS = 40_000;   // stop starting new records after this; the rest are picked up next time
const BATCH = 20;
const ALERTS = 10;          // alerts per run (each waits up to 2 s for Sentry); the rest are raised next run

/** Why a run that got past the due list still answers 500 (codes only, never an account id). */
type Problem = "records_failed" | "attention_check" | "alert_marking" | "heartbeat";

async function run(request: Request) {
  const auth = bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "unset") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "no") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // from here on the caller is the scheduler (or a holder of the secret): monitored
  const startedAt = Date.now();
  const checkIn = startRetryCheckIn();
  let res: NextResponse;
  try {
    res = await runAuthorised();
  } catch (e) {
    await finishRetryCheckIn(checkIn, 500, startedAt);
    throw e;
  }
  await finishRetryCheckIn(checkIn, res.status, startedAt);
  return res;
}

/** The run itself, unchanged by the monitoring around it. */
async function runAuthorised(): Promise<NextResponse> {
  const deps = await serviceDeps();
  const promoted = await deps.rpc("promote_due_requests", {});
  if (promoted.error) {
    await report("deletionStepFailed", "account", { code: promoted.error.code ?? "promote" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
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
  const problems: Problem[] = [];
  if (counts.failed > 0) problems.push("records_failed");
  const attention = await deps.rpc("deletions_needing_attention", {});
  if (attention.error || !Array.isArray(attention.data)) {
    problems.push("attention_check");
    await report("deletionStepFailed", "account", { code: attention.error?.code ?? "attention" });
  } else {
    for (const row of (attention.data as Array<{ subject_id?: unknown; reason?: unknown }>).slice(0, ALERTS)) {
      if (typeof row?.subject_id !== "string") continue;
      if (Date.now() - started > BUDGET_MS + 10_000) break;   // stay well inside maxDuration
      await report("deletionNeedsAttention", "account", { code: row.reason === "held" ? "held" : "stuck" });
      const m = await deps.rpc("mark_deletion_alerted", { p_subject: row.subject_id });
      if (!m.error) alerts++;
      else if (!problems.includes("alert_marking")) problems.push("alert_marking");
    }
  }
  const summary = { ...counts, remaining: subjects.length - processed, alerts, promoted: typeof promoted.data === "number" ? promoted.data : 0 };
  // the heartbeat: only a run that got this far counts (a failing run lets the app's one-step closing pause)
  const beat = await deps.rpc("record_deletion_worker_run", { p_counts: summary });
  if (beat.error) {
    problems.push("heartbeat");
    await report("deletionStepFailed", "account", { code: beat.error.code ?? "heartbeat" });
  }
  // a run with any problem is a failed run for the scheduler; nothing above depends on this status
  if (problems.length > 0) return NextResponse.json({ ...summary, error: "run_incomplete", problems }, { status: 500 });
  return NextResponse.json(summary);
}

export const GET = run;    // Vercel Cron calls GET
export const POST = run;
