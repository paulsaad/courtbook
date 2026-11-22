/**
 * Our own error reports (W2a). Only fixed messages from SAFE_MESSAGES are sent; details travel as short codes
 * (a database error code such as 23P01, an HTTP status), never as text. With no DSN configured the SDK is off and
 * these calls do nothing.
 *
 * The SDK is imported when first needed, not bundled into every page (see instrumentation-client.ts). In the
 * browser, instrumentation-client.ts starts that same import first, so the SDK is set up before any report runs.
 */
let loading: Promise<typeof import("@sentry/nextjs")> | undefined;
const sdk = () => (loading ??= import("@sentry/nextjs").catch((e) => { loading = undefined; throw e; }));   // one import; retried after a failed download
import { friendlyError } from "@/lib/types";
import { SAFE_MESSAGES, type Area, type SafeMessageKey } from "@/lib/monitoring";

/** A code is sent only if it looks like a code (SQLSTATE "23P01", PostgREST "PGRST116", "bad_duration"). */
export function safeCode(code: unknown): string | undefined {
  if (typeof code !== "string" && typeof code !== "number") return undefined;
  const s = String(code);
  return /^[A-Za-z0-9_]{1,24}$/.test(s) ? s : "other";
}

/** Reports still waiting for the SDK; tests wait on these (reportsSettled) instead of on timing. */
const pending = new Set<Promise<void>>();
export const reportsSettled = () => Promise.all([...pending]).then(() => {});

export function report(key: SafeMessageKey, area: Area, detail: { code?: unknown; status?: number } = {}): Promise<void> {
  const tags: Record<string, string> = { area };
  const code = safeCode(detail.code);
  if (code) tags.code = code;
  if (typeof detail.status === "number") tags.status = String(detail.status);
  const sent = sdk().then(async (S) => {
    S.captureMessage(SAFE_MESSAGES[key], { level: "error", tags });
    // a server function may be frozen as soon as it has answered: send before answering (error paths only)
    if (typeof window === "undefined") await S.flush(2000);
  }, () => {}).finally(() => pending.delete(sent));
  pending.add(sent);
  return sent;
}

/** The two texts friendlyError shows when it does not recognise the error: those are the unexpected ones. */
export const FALLBACK_TEXTS = new Set([friendlyError(undefined), friendlyError("\u0000unrecognised")]);

/**
 * For a booking-path failure: returns the text to show (unchanged from before W2a) and, when that text is the
 * generic fallback, reports it. Known refusals (slot taken, too late to cancel, …) are expected and not reported.
 * `shown` lets a caller with its own wording (blocks) pass what it will display.
 */
export function explainBookingError(message: string | undefined, code?: unknown, shown?: string): string {
  const text = shown ?? friendlyError(message);
  if (FALLBACK_TEXTS.has(text)) void report("bookingUnexpected", "booking", { code });
  return text;
}

/**
 * Sign-in failures that are not the person's doing: the auth service answered 5xx (it is down, or could not send
 * the email), or — on the server only — could not be reached at all. A wrong or expired code, a used link or a
 * rate limit (4xx) is expected and not reported; nor is a phone that is offline (no status in the browser).
 */
export async function reportAuthError(key: SafeMessageKey, error: { status?: number; code?: string } | null | undefined, server = false): Promise<void> {
  if (!error) return;
  const s = error.status;
  if ((typeof s === "number" && s >= 500) || (server && !s)) await report(key, "auth", { code: error.code, status: s || undefined });
}

/**
 * An error page was shown. A server error carries a digest and was already reported by the server
 * (onRequestError), so only browser-side errors are sent from here. The message is withheld by scrubEvent
 * unless it is one of our fixed ones (W1's "Couldn't load …").
 */
export function reportBoundary(error: (Error & { digest?: string }) | undefined): void {
  if (!error || error.digest) return;
  void sdk().then((S) => { S.captureException(error, { tags: { area: "page" } }); }, () => {});
}
