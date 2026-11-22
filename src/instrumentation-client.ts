import { baseOptions } from "@/lib/monitoring";

/**
 * Browser-side error monitoring (W2a). Off unless NEXT_PUBLIC_SENTRY_DSN is set; every event passes scrubEvent.
 * The environment name is fixed at build time in next.config.ts.
 *
 * The SDK is loaded as a separate file, started here before the page hydrates, instead of being bundled into every
 * page: measured 22 Nov, the shared JavaScript every page downloads grows by about 2 KB (gzip) this way and by about
 * 46 KB if bundled. The cost: an uncaught error thrown in the first moments, before that file arrives, is not seen.
 * Our own reports (booking, sign-in, error pages) wait for the SDK, so they are never lost to this. A failed
 * download of the SDK is ignored; the site works the same without it.
 */
void import("@sentry/nextjs")
  .then((Sentry) => Sentry.init(baseOptions(process.env.NEXT_PUBLIC_SENTRY_DSN, process.env.NEXT_PUBLIC_MONITORING_ENV ?? "development")))
  .catch(() => {});
