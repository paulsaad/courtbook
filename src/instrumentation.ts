import * as Sentry from "@sentry/nextjs";
import { baseOptions, monitoringEnvironment } from "@/lib/monitoring";

/** Server-side error monitoring (W2a). Off unless NEXT_PUBLIC_SENTRY_DSN is set; every event passes scrubEvent. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init(baseOptions(
      process.env.NEXT_PUBLIC_SENTRY_DSN,
      monitoringEnvironment(process.env.VERCEL_ENV, process.env.VERCEL_GIT_COMMIT_REF),
    ));
  }
}

/** Errors thrown while rendering a page or running a route: sent with the method and normalised path only. */
export const onRequestError = Sentry.captureRequestError;
