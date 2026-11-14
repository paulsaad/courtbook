import * as Sentry from "@sentry/react-native";
import * as Updates from "expo-updates";
import * as Application from "expo-application";
import { installedVariant } from "./appIdentity";

/**
 * Crash and error reports from real phones (Sentry). Off unless EXPO_PUBLIC_SENTRY_DSN is set, so a
 * build without it behaves exactly as before.
 *
 * Privacy: no personal data is sent. sendDefaultPii is off (no IP address, no cookies, no request
 * bodies); no user is attached; any email address that slips into a message or breadcrumb is masked.
 * Reports say which app (live or staging), which version and which update, so a crash can be tied
 * to exact code.
 */
const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
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

export function startCrashReporting() {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: installedVariant ?? "development",
    release: `courtbook@${Application.nativeApplicationVersion ?? "?"}+${Application.nativeBuildVersion ?? "?"}`,
    dist: Updates.updateId ?? "built-in",
    tracesSampleRate: 0,
    beforeSend: (event) => {
      delete event.user;
      if (event.request) { delete event.request.cookies; delete event.request.data; }
      return maskEmails(event);
    },
    beforeBreadcrumb: (b) => maskEmails(b),
  });
  return true;
}

export const wrapRoot = Sentry.wrap;
