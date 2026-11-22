import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { monitoringEnvironment } from "./src/lib/monitoring";

/** Security headers on every response (website completion W1). HSTS is already sent by Vercel. A full
 *  Content-Security-Policy is a later item (audit O1); only framing is restricted here. */
export const securityHeaders = [
  // no other site may show CourtBook inside a frame (clickjacking on staff and admin actions)
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera and microphone: never used. Location: CourtBook's own pages may ask (the approved optional "Use my
  // location" for nearby clubs, still behind the browser's own prompt); embedded third-party frames may not.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
];

const nextConfig: NextConfig = {
  // the monitoring environment (production / staging / preview / development), fixed when the site is built
  env: { NEXT_PUBLIC_MONITORING_ENV: monitoringEnvironment(process.env.VERCEL_ENV, process.env.VERCEL_GIT_COMMIT_REF) },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Pages read the auth cookie on every request; keep the classic dynamic-rendering model.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

/** Error monitoring (W2a). Source maps are uploaded only when the build has the upload-only token
 *  (SENTRY_AUTH_TOKEN, a build variable, never NEXT_PUBLIC_), and are deleted from the build output after upload
 *  so they are never served. Without the token the build is unchanged apart from the SDK. */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN, deleteSourcemapsAfterUpload: true },
  // No tunnel: left unset, Vercel builds get a generated /sentry-tunnel route and a rewrite (found on the preview,
  // 22 Nov). The browser sends straight to Sentry; no extra public endpoint.
  tunnelRoute: false,
  // Navigation tracing is off (tracesSampleRate 0), so the onRouterTransitionStart hook is not needed.
  suppressOnRouterTransitionStartWarning: true,
  bundleSizeOptimizations: {
    excludeDebugStatements: true,
    excludeTracing: true,
    excludeReplayIframe: true,
    excludeReplayShadowDom: true,
    excludeReplayWorker: true,
  },
});
