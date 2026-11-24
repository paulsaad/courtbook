import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bearerMatches } from "@/lib/deletion/request";
import { report } from "@/lib/report";
import { getProvider } from "@/lib/payments";
import { runPaymentReconciliation } from "@/lib/payments/reconcile";

/**
 * M12.2: the payment reconciliation run (sweep open attempts, then reconcile the provider's own charge list).
 * Meant to be called on a schedule; NO SCHEDULE IS CONFIGURED — activation is a separate approval, after the
 * provider is verified (and see the run budget note in the PR: on Vercel Hobby, two 15-minute schedules would exceed
 * 5,000 runs a month).
 *
 * Caller: "Authorization: Bearer <CRON_SECRET>" (the same rule as the deletion retry route). Unset or short secret →
 * 503, wrong → 401; nothing is done. Takes no input: what to check comes from the database and the provider.
 * Answers counts only (never an id, a reference or an amount). 200 only when the run needs nobody; 500 with
 * `problems` (codes) when it does — a conflict between the provider's records and ours, a list that could not be
 * read, or failures — and each problem is also reported to Sentry with a fixed message.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(request: Request) {
  const auth = bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (auth === "unset") return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (auth === "no") return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let summary;
  try {
    summary = await runPaymentReconciliation(createAdminClient(), getProvider());
  } catch {
    await report("paymentReconcile", "payment", { code: "run" });
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
  for (const p of summary.problems) await report(p === "conflicts" ? "paymentConflict" : "paymentReconcile", "payment", { code: p });
  const body = {
    checked: summary.sweep.checked, outcomes: summary.sweep.outcomes, sweepFailures: summary.sweep.failures,
    charges: summary.reconcile ? { seen: summary.reconcile.seen, outcomes: summary.reconcile.outcomes, conflicts: summary.reconcile.conflicts, failures: summary.reconcile.failures } : null,
    ...(summary.problems.length ? { problems: summary.problems } : {}),
  };
  return NextResponse.json(body, { status: summary.problems.length ? 500 : 200 });
}

export const GET = run;
export const POST = run;
