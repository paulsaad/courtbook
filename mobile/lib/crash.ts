import * as Sentry from "@sentry/react-native";
import type { Breadcrumb, ErrorEvent } from "@sentry/react-native";
import * as Updates from "expo-updates";
import * as Application from "expo-application";
import { installedVariant } from "./appIdentity";

/**
 * Crash and error reports from real phones (Sentry). Off unless EXPO_PUBLIC_SENTRY_DSN is set, so a
 * build without it behaves exactly as before.
 *
 * What a report never contains (scrubEvent / scrubBreadcrumb, unit-tested):
 *   - who: no user, no IP address (sendDefaultPii off), no device name, no server name;
 *   - what they typed or saw: no taps (their breadcrumbs carry on-screen text), no request or
 *     response bodies, no headers or cookies, no query strings (filters and tokens);
 *   - any email address that reaches a message, exception or breadcrumb is masked.
 * What it does contain: the error and stack, the screen path, app (environment "production" or
 * "staging", from the installed bundle ID), version and build, and the update ID (dist), so a crash
 * ties to exact code.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function maskEmails<T>(value: T): T {
  if (typeof value === "string") return value.replace(EMAIL, "[email]") as T;
  if (Array.isArray(value)) return value.map(maskEmails) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskEmails(v);
    return out as T;
  }
  return value;
}

const stripQuery = (u: unknown) => (typeof u === "string" ? u.split("?")[0] : u);

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const e = { ...event };
  delete e.user;
  delete e.server_name;
  if (e.request) e.request = { url: stripQuery(e.request.url) as string | undefined, method: e.request.method };
  if (e.contexts?.device) e.contexts = { ...e.contexts, device: { ...e.contexts.device, name: undefined } };
  if (e.breadcrumbs) e.breadcrumbs = e.breadcrumbs.map(scrubBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  return maskEmails(e);
}

export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb | null {
  if (b.category === "touch" || b.category?.startsWith("ui.")) return null; // labels = on-screen text
  if (b.category === "fetch" || b.category === "xhr" || b.type === "http") {
    const d = b.data ?? {};
    return maskEmails({ ...b, data: { method: d.method, url: stripQuery(d.url), status_code: d.status_code } });
  }
  return maskEmails(b);
}

export function startCrashReporting(dsn = process.env.EXPO_PUBLIC_SENTRY_DSN) {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: installedVariant ?? "development",
    release: `courtbook@${Application.nativeApplicationVersion ?? "?"}+${Application.nativeBuildVersion ?? "?"}`,
    dist: Updates.updateId ?? "built-in",
    tracesSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (b) => scrubBreadcrumb(b),
  });
  return true;
}

/** For the Test tools: a handled test error, so a report can be checked end to end. */
export function sendTestReport() {
  Sentry.captureException(new Error(`CourtBook test report (${installedVariant ?? "development"})`));
}

export const wrapRoot = Sentry.wrap;
