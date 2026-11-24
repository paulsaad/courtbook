import * as Sentry from "@sentry/nextjs";

/**
 * Sentry cron monitor for the deletion retry runs (deletion-schedule, review 24 Nov).
 *
 * Only runs that passed the bearer check send check-ins: `in_progress` when the run starts, then `ok` for a 200 and
 * `error` for anything else. Unauthenticated or unconfigured calls (401, 503) send nothing, so a schedule that stops
 * firing, or a deployment without CRON_SECRET, shows up as a *missed* check-in in Sentry.
 *
 * The schedule mirrors vercel.json (a test keeps them equal). Vercel Schedules on Hobby start each run up to 15 minutes
 * after the slot (fixed jitter window), so the margin is 20 minutes; on Pro (1-minute jitter) it can drop to 5.
 * Check-ins carry the monitor slug, status, duration and the SDK's environment (staging / production) only.
 * With no DSN configured the SDK is off and these calls do nothing.
 */
export const RETRY_MONITOR = "deletion-retry";
export const RETRY_SCHEDULE = "7,22,37,52 * * * *";
export const RETRY_MONITOR_CONFIG = {
  schedule: { type: "crontab", value: RETRY_SCHEDULE },
  checkinMargin: 20,        // minutes: Hobby's 15-minute jitter plus delivery slack
  maxRuntime: 2,            // minutes: the route stops at 60 s (maxDuration)
  timezone: "Etc/UTC",
  failureIssueThreshold: 1,
  recoveryThreshold: 1,
} as const;

/** Never lets monitoring break or delay a run beyond the flush. */
export function startRetryCheckIn(): string | undefined {
  try {
    return Sentry.captureCheckIn({ monitorSlug: RETRY_MONITOR, status: "in_progress" }, RETRY_MONITOR_CONFIG);
  } catch {
    return undefined;
  }
}

export async function finishRetryCheckIn(checkInId: string | undefined, httpStatus: number, startedAt: number): Promise<void> {
  try {
    Sentry.captureCheckIn({
      ...(checkInId ? { checkInId } : {}),
      monitorSlug: RETRY_MONITOR,
      status: httpStatus === 200 ? "ok" : "error",
      duration: (Date.now() - startedAt) / 1000,
    });
    // a server function may be frozen as soon as it has answered: send first
    await Sentry.flush(2000);
  } catch {
    /* monitoring is best effort */
  }
}
