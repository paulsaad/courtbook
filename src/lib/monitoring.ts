/**
 * Website error monitoring (W2a): what may leave the site, decided here and nowhere else.
 *
 * Principle (review correction, 22 Nov 2026): no free text leaves the site. An error message can carry a name, a
 * database row, an email or a sign-in code in a shape no pattern would catch, so messages are not masked — they are
 * WITHHELD unless they are one of our own fixed messages. Every event is rebuilt from an allowlist (scrubEvent):
 *   - message: a fixed message from SAFE_MESSAGES, or "[withheld]";
 *   - exception: type kept; value kept only if fixed (ours, W1's "Couldn't load …", React's error number);
 *   - stack: file, function, line, column; no source lines, no local variables;
 *   - URLs everywhere: path only, IDs replaced, no query string (so no sign-in codes) and no fragment;
 *   - request: method and normalised path; no headers, cookies, body or query;
 *   - breadcrumbs: navigation and network only (method, normalised URL, status); everything else dropped;
 *   - tags: allowlist; contexts: browser, OS, runtime (name and version) and trace ids;
 *   - user, IP, server name, extra, modules: never.
 * Pure functions only (no SDK import), unit-tested in monitoring.test.ts; the SDK wiring is in
 * instrumentation.ts, instrumentation-client.ts and report.ts.
 */
import type { Breadcrumb, ErrorEvent, Exception, StackFrame } from "@sentry/nextjs";

/** The only messages our own reporting may send. Fixed text; details travel as allowlisted tags (codes). */
export const SAFE_MESSAGES = {
  bookingUnexpected: "booking: unexpected error",
  authCodeExchange: "auth: code exchange failed",
  authCodeSend: "auth: sign-in code could not be sent",
  authCodeCheck: "auth: sign-in code could not be checked",
  authGoogleStart: "auth: Google sign-in could not start",
  mediaPermission: "media: permission check failed",
  mediaOrphan: "media: unused file could not be removed or recorded",
  mediaPublishUnknown: "media: publish state unknown",
  mediaRemoveUnknown: "media: removal state unknown",
  paymentLookup: "payment: lookup failed",
  testServer: "CourtBook monitoring test (server)",
  testBrowser: "CourtBook monitoring test (browser)",
} as const;
export type SafeMessageKey = keyof typeof SAFE_MESSAGES;
export type Area = "booking" | "auth" | "media" | "payment" | "page" | "test";

/** Fake personal data for the staging test: none of it may ever appear in a Sentry event. */
export const PRIVACY_PROBE = "privacy probe: Jana Probe, probe@example.invalid, +961 70 123 456, code 482913";

const FIXED = new Set<string>(Object.values(SAFE_MESSAGES));
export const WITHHELD = "[withheld]";

/** W1's LoadError messages are built from constant labels ("Couldn't load your bookings"). */
const LOAD_ERROR = /^Couldn't load [a-z' ]{1,40}$/i;
/** React production errors: keep the number only (the rest is a URL whose arguments can carry data). */
const REACT_ERROR = /^Minified React error #(\d+)/;

/** A message is sent only if it is fixed; otherwise it is withheld. W1's load errors are kept only as the
 *  exception value of a LoadError (their labels are constants in our code: "your bookings", "this club"). */
export function safeText(text: unknown, exceptionType?: string): string {
  if (typeof text !== "string") return WITHHELD;
  if (FIXED.has(text)) return text;
  if (exceptionType === "LoadError" && LOAD_ERROR.test(text)) return text;
  const react = REACT_ERROR.exec(text);
  if (react) return `Minified React error #${react[1]}`;
  return WITHHELD;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path only: no origin change, no query, no fragment; IDs, numbers and token-like segments replaced. */
export function normalizePath(input: unknown): string | undefined {
  if (typeof input !== "string" || !input) return undefined;
  let s = input.split("#")[0].split("?")[0];
  let origin = "";
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(.*)$/i.exec(s);
  if (m) { origin = m[1]; s = m[2] || "/"; }
  const path = s.split("/").map((seg) => {
    if (!seg) return seg;
    if (UUID.test(seg)) return ":id";
    if (/^\d+$/.test(seg)) return ":n";
    if (seg.length >= 20 && /^[A-Za-z0-9_\-.%=]+$/.test(seg) && !/^[a-z-]+$/.test(seg)) return ":token";
    if (seg.includes("@")) return ":value";
    return seg;
  }).join("/");
  return origin + path;
}

/** A transaction name is "METHOD /path" or a path; normalised the same way. */
function normalizeTransaction(t: unknown): string | undefined {
  if (typeof t !== "string") return undefined;
  const m = /^([A-Z]+) (.*)$/.exec(t);
  return m ? `${m[1]} ${normalizePath(m[2])}` : normalizePath(t);
}

function scrubFrame(f: StackFrame): StackFrame {
  return {
    filename: normalizePath(f.filename),
    abs_path: normalizePath(f.abs_path), // kept (no query) so source maps resolve; a file URL, never data
    function: f.function,
    module: f.module,
    lineno: f.lineno,
    colno: f.colno,
    in_app: f.in_app,
  };
}

function scrubException(x: Exception): Exception {
  return {
    type: typeof x.type === "string" ? x.type.slice(0, 80) : undefined,
    value: safeText(x.value, x.type),
    mechanism: x.mechanism ? { type: x.mechanism.type, handled: x.mechanism.handled } : undefined,
    stacktrace: x.stacktrace?.frames ? { frames: x.stacktrace.frames.map(scrubFrame) } : undefined,
  };
}

const TAGS = new Set(["area", "code", "status", "runtime"]);

function pick<T extends object>(o: T | undefined, keys: string[]): Partial<T> | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) if ((o as Record<string, unknown>)[k] !== undefined) out[k] = (o as Record<string, unknown>)[k];
  return out as Partial<T>;
}

/** Network and navigation breadcrumbs only, reduced to method, normalised URL and status. */
export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb | null {
  const d = (b.data ?? {}) as Record<string, unknown>;
  if (b.category === "navigation") {
    return { category: "navigation", timestamp: b.timestamp, data: { from: normalizePath(d.from), to: normalizePath(d.to) } };
  }
  if (b.category === "fetch" || b.category === "xhr" || b.type === "http") {
    return {
      type: "http", category: b.category, timestamp: b.timestamp, level: b.level,
      data: { method: d.method, url: normalizePath(d.url), status_code: d.status_code },
    };
  }
  return null;
}

/** Rebuilds an event from the allowlist. Returns null to drop it. */
export function scrubEvent(e: ErrorEvent): ErrorEvent | null {
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.tags ?? {})) if (TAGS.has(k) && v != null) tags[k] = String(v).slice(0, 64);

  const contexts: NonNullable<ErrorEvent["contexts"]> = {};
  for (const k of ["browser", "os", "runtime"] as const) {
    const c = pick(e.contexts?.[k] as Record<string, unknown> | undefined, ["name", "version"]);
    if (c && Object.keys(c).length) contexts[k] = c;
  }
  const t = e.contexts?.trace;
  if (t?.trace_id && t.span_id) contexts.trace = { trace_id: t.trace_id, span_id: t.span_id };

  const out: ErrorEvent = {
    type: undefined,
    event_id: e.event_id,
    timestamp: e.timestamp,
    platform: e.platform,
    level: e.level,
    environment: e.environment,
    release: e.release,
    dist: e.dist,
    sdk: e.sdk,
    debug_meta: e.debug_meta, // source-map ids, needed for readable stacks
    fingerprint: e.fingerprint,
    transaction: normalizeTransaction(e.transaction),
    tags,
    contexts,
  };
  if (e.message !== undefined) out.message = safeText(e.message);
  if (e.logentry) out.logentry = { message: safeText(e.logentry.message) };
  if (e.exception?.values) out.exception = { values: e.exception.values.map(scrubException) };
  if (e.request) out.request = { method: e.request.method, url: normalizePath(e.request.url) };
  if (e.breadcrumbs) out.breadcrumbs = e.breadcrumbs.map(scrubBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  return out;
}

/** Network noise from phones and browsers: not our failures, never reported. Matched before scrubbing. */
export const IGNORE_ERRORS: (string | RegExp)[] = [
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource",
  "The user aborted a request",
  /^AbortError/,
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
];

/** "production" | "staging" (branch m3-dev) | "preview" (other branches) | "development". */
export function monitoringEnvironment(vercelEnv: string | undefined, gitRef: string | undefined): string {
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return gitRef === "m3-dev" ? "staging" : "preview";
  return "development";
}

/** Release-health sessions are sent outside beforeSend and carry a user id ("did") and an IP request
 *  ("{{auto}}") whenever any code sets a user: not sent at all (found by monitoring.sdk.test.ts). */
export const DROPPED_INTEGRATIONS = new Set(["BrowserSession", "ProcessSession"]);

/** Options shared by the browser and the server. The SDK stays off without a DSN. */
export function baseOptions(dsn: string | undefined, environment: string) {
  return {
    dsn,
    enabled: !!dsn,
    environment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 30,
    ignoreErrors: IGNORE_ERRORS,
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
    beforeBreadcrumb: (b: Breadcrumb) => scrubBreadcrumb(b),
    integrations: <I extends { name: string }>(defaults: I[]) => defaults.filter((i) => !DROPPED_INTEGRATIONS.has(i.name)),
  };
}
