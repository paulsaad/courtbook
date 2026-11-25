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
import type { DataCollection } from "@sentry/core";

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
  paymentStart: "payment: attempt could not start",
  paymentRecord: "payment: provider result could not be recorded",
  paymentProvider: "payment: provider unavailable",
  paymentReconcile: "payment: reconciliation run needs attention",
  paymentConflict: "payment: provider records conflict with a recorded charge",
  accountCloseFailed: "account: closing failed",
  deletionStepFailed: "account: deletion step failed",
  deletionNeedsAttention: "account: deletion needs attention",
  testServer: "CourtBook monitoring test (server)",
  testBrowser: "CourtBook monitoring test (browser)",
} as const;
export type SafeMessageKey = keyof typeof SAFE_MESSAGES;
export type Area = "booking" | "auth" | "media" | "payment" | "page" | "test" | "account";

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

/* ---------------------------------------------------------------------------------------------------------------
 * URLs and paths (review correction, 22 Nov: no arbitrary segment survives).
 * A path on our site is sent only as its route template ("/club/:slug/info"); a path that matches no route becomes
 * "/[unmatched]". Supabase URLs keep only the API, table or function name. Any other site keeps only its host, and
 * only if the host is on the list. No query string or fragment, anywhere.
 * ------------------------------------------------------------------------------------------------------------- */

/** Every page and route of the website (src/app). Kept in step with the folders by monitoring.routes.test.ts. */
export const ROUTES = [
  "/", "/account-closed", "/admin", "/admin/clubs/[slug]", "/admin/deletions", "/admin/monitoring", "/admin/payments", "/admin/reports", "/age",
  "/api/account/close", "/api/admin/delete-account", "/api/club-media", "/api/internal/deletions/retry", "/api/internal/payments/sweep", "/api/health", "/api/monitoring/test", "/api/native/pay/start", "/api/native/pay/status", "/api/notify/email", "/api/pay/callback/[provider]", "/api/pay/simulate", "/api/pay/start", "/api/payments.csv",
  "/auth/callback", "/auth/signout", "/bookings", "/bookings/[id]", "/club/[slug]", "/club/[slug]/coaches",
  "/club/[slug]/info", "/club/[slug]/matches", "/coach", "/coaches", "/coaches/[id]", "/courts", "/delete-account", "/levels", "/login",
  "/matches/[id]", "/me", "/notifications", "/pay/[id]", "/pay/app-return", "/pay/return", "/play", "/privacy", "/profile", "/staff", "/staff/[slug]",
  "/staff/[slug]/payments", "/staff/[slug]/settings", "/terms",
  // files served by the app itself
  "/favicon.ico", "/icon.png", "/manifest.webmanifest",
] as const;

export const UNMATCHED = "/[unmatched]";
export const REDACTED = "[redacted]";

const TEMPLATES = ROUTES.map((r) => (r === "/" ? [] : r.slice(1).split("/")));
const isDynamic = (seg: string) => seg.startsWith("[") && seg.endsWith("]");

/** "/club/tripoli-tennis/info" → "/club/:slug/info"; anything that is not one of our routes → "/[unmatched]". */
export function routeTemplate(path: string): string {
  const segs = path.split("/").filter(Boolean);
  let best: string[] | null = null;
  let bestStatic = -1;
  for (const t of TEMPLATES) {
    if (t.length !== segs.length) continue;
    if (!t.every((ts, i) => (isDynamic(ts) ? segs[i].length > 0 : ts === segs[i]))) continue;
    const statics = t.filter((ts) => !isDynamic(ts)).length;
    if (statics > bestStatic) { best = t; bestStatic = statics; }
  }
  if (!best) return UNMATCHED;
  return "/" + best.map((ts) => (isDynamic(ts) ? `:${ts.slice(1, -1)}` : ts)).join("/");
}

/** Hosts whose name may be sent: our own deployments, local development and Supabase. */
const OUR_HOST = /^(?:courtbook[a-z0-9-]{0,60}\.vercel\.app|localhost(?::\d{1,5})?|127\.0\.0\.1(?::\d{1,5})?)$/;
const SUPABASE_HOST = /^[a-z0-9]{20}\.supabase\.co$/;
const KNOWN_HOST = /^(?:[a-z0-9-]{1,63}\.)*(?:googleapis\.com|gstatic\.com|google\.com|sentry\.io)$/;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
/** Build files under /_next/: hashed names only (letters, digits, - _ . and the folders). */
const NEXT_FILE = /^\/_next\/[A-Za-z0-9_\-./]{1,200}$/;

function supabasePath(path: string): string {
  const s = path.split("/").filter(Boolean);
  if (s[0] === "rest" && s[1] === "v1") {
    if (s.length === 3 && IDENT.test(s[2])) return `/rest/v1/${s[2]}`;
    if (s.length === 4 && s[2] === "rpc" && IDENT.test(s[3])) return `/rest/v1/rpc/${s[3]}`;
    return `/rest/v1/${REDACTED}`;
  }
  if ((s[0] === "auth" || s[0] === "functions") && s[1] === "v1") {
    return s.length === 3 && IDENT.test(s[2]) ? `/${s[0]}/v1/${s[2]}` : `/${s[0]}/v1/${REDACTED}`;
  }
  if (s[0] === "storage" && s[1] === "v1") return `/storage/v1/${REDACTED}`;   // object paths name clubs and files
  return `/${REDACTED}`;
}

function ourPath(path: string): string {
  if (path.startsWith("/_next/")) return NEXT_FILE.test(path) ? path : `/_next/${REDACTED}`;
  return routeTemplate(path);
}

/**
 * Any URL or path, made safe to send. Our site: route template (or a build file under /_next/). Supabase: API and
 * name only. A listed third-party host: host only. Anything else: "[redacted]".
 */
export function normalizeUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || !input) return undefined;
  const s = input.split("#")[0].split("?")[0];
  if (s.startsWith("/") && !s.startsWith("//")) return ourPath(s);
  const m = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(s);
  if (!m) return REDACTED;
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  const path = m[3] ?? "/";
  if (OUR_HOST.test(host)) return `${scheme}://${host}${ourPath(path)}`;
  if (SUPABASE_HOST.test(host)) return `${scheme}://${host}${supabasePath(path)}`;
  if (KNOWN_HOST.test(host)) return `${scheme}://${host}/${REDACTED}`;
  return REDACTED;
}

/** Server build paths ("/var/task/.next/server/chunks/ssr/…", "…/node_modules/…", "node:internal/…"): file-name
 *  characters only, and only inside the build output, the installed packages or Node itself. */
const SERVER_FILE = /^(?:app:\/\/\/|file:\/\/\/?)?[A-Za-z0-9_\-./\[\]()@~+]{1,300}$/;
const SERVER_PLACE = /(?:^|\/)(?:\.next|node_modules)\//;
const NODE_INTERNAL = /^node:[a-z_/]{1,100}$/;
const EMAIL_LIKE = /[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

/** A stack frame's file, in a form that still lets Sentry apply the right source map. */
/** Build files as @sentry/nextjs renames them before beforeSend runs: browser chunks and server chunks become
 *  "app:///_next/static/…" and "app:///_next/server/…" (seen in the staging events, 22 Nov). */
const APP_NEXT_FILE = /^app:\/\/\/_next\/[A-Za-z0-9_\-./\[\]()@~+]{1,300}$/;

export function safeFile(input: unknown): string | undefined {
  if (typeof input !== "string" || !input) return undefined;
  if (input === "<anonymous>" || input === "[native code]") return input;
  if (input.startsWith("app:///_next/")) {
    const s = input.split("#")[0].split("?")[0];
    return APP_NEXT_FILE.test(s) && !EMAIL_LIKE.test(s) ? s : REDACTED;
  }
  if (/^https?:\/\//i.test(input) || (input.startsWith("/_next/"))) return normalizeUrl(input);
  const s = input.split("#")[0].split("?")[0];
  if (NODE_INTERNAL.test(s)) return s;
  return SERVER_FILE.test(s) && SERVER_PLACE.test(s) && !EMAIL_LIKE.test(s) ? s : REDACTED;
}

/** A file a source map can belong to: a browser build file under /_next/ or a server build file. */
function isBuildFile(file: string): boolean {
  if (file.includes(REDACTED) || file.includes(UNMATCHED)) return false;
  return /^(?:https?:\/\/[^/]+|app:\/\/)?\/_next\//.test(file) || SERVER_PLACE.test(file);
}

/* ---------------------------------------------------------------------------------------------------------------
 * Strict formats for every other field (review correction, 22 Nov): a value that does not have the expected shape
 * is dropped or replaced, never forwarded as is.
 * ------------------------------------------------------------------------------------------------------------- */

/** A JavaScript function name as stack traces print it: an identifier or a dotted path of identifiers
 *  ("reserve", "Object.reserve", "Array.prototype.map"), "<anonymous>" as a part, and at most one "async " or "new "
 *  in front. No other spaces, no punctuation: "Jana Probe", an email or a phone number cannot match. */
const IDENTIFIER = "(?:<anonymous>|[A-Za-z_$][A-Za-z0-9_$]{0,79})";
const FUNCTION_NAME = new RegExp(`^(?:(?:async|new) )?${IDENTIFIER}(?:\\.${IDENTIFIER}){0,5}$`);
const EXCEPTION_TYPE = /^(?:Error|[A-Z][A-Za-z0-9_]{0,60}(?:Error|Exception))$/;   // TypeError, LoadError, DOMException
const MECHANISM_TYPE = /^[a-z][a-z0-9_.]{0,59}$/;
const LEVELS = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const ENVIRONMENTS = new Set(["production", "staging", "preview", "development", "test"]);
const RELEASE = /^[0-9a-f]{7,40}$/;   // the commit SHA (Vercel); nothing else is a release here
const EVENT_ID = /^[0-9a-f]{32}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const DEBUG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SDK_NAME = /^sentry\.[a-z.]{1,60}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-.][A-Za-z0-9.]{1,30})?$/;
/** Context names: known values only. Versions: version-shaped only ("131.0.6778.135", "v22.11.0", "15"). */
const CONTEXT_NAMES: Record<"browser" | "os" | "runtime", Set<string>> = {
  browser: new Set(["Chrome", "Chrome Mobile", "Chrome Mobile iOS", "Chrome Mobile WebView", "Chromium", "Safari",
    "Mobile Safari", "Firefox", "Firefox Mobile", "Firefox iOS", "Edge", "Edge Mobile", "Opera", "Opera Mobile",
    "Samsung Internet", "Brave", "WebKit", "Facebook", "Instagram"]),
  os: new Set(["Android", "iOS", "iPadOS", "macOS", "Mac OS X", "Windows", "Linux", "Chrome OS", "ChromeOS", "Ubuntu",
    "Debian", "Amazon Linux", "Darwin"]),
  runtime: new Set(["node", "edge", "vercel-edge", "browser"]),
};
const CONTEXT_VERSION = /^v?\d{1,6}(?:\.\d{1,6}){0,3}(?:[-+][A-Za-z0-9._]{1,40})?$/;
const AREAS = new Set<string>(["booking", "auth", "media", "payment", "page", "test", "account"]);

const ok = <T>(v: unknown, test: (x: string) => boolean): T | undefined =>
  typeof v === "string" && test(v) ? (v as T) : undefined;
const re = (r: RegExp) => (x: string) => r.test(x);
const count = (v: unknown, max = 1e8): number | undefined => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < max ? (v as number) : undefined);
const time = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

/** Tag values have one fixed shape per tag; anything else drops the tag. */
const TAG_VALUE: Record<string, (v: string) => boolean> = {
  area: (v) => AREAS.has(v),
  code: re(/^[A-Za-z0-9_]{1,24}$/),
  status: re(/^[1-5]\d{2}$/),
  runtime: re(/^(?:node|edge|browser)$/),
};

/** A transaction name is "METHOD /path" or a path; normalised the same way. */
function normalizeTransaction(t: unknown): string | undefined {
  if (typeof t !== "string") return undefined;
  const m = /^([A-Z]+) (.*)$/.exec(t);
  if (m) return METHODS.has(m[1]) ? `${m[1]} ${normalizeUrl(m[2])}` : undefined;
  return normalizeUrl(t);
}

function scrubFrame(f: StackFrame): StackFrame {
  return {
    filename: safeFile(f.filename),
    abs_path: safeFile(f.abs_path), // matched against debug_meta's code_file: both normalised the same way
    function: typeof f.function === "string" ? (FUNCTION_NAME.test(f.function) ? f.function : "?") : undefined,
    lineno: count(f.lineno),
    colno: count(f.colno),
    in_app: typeof f.in_app === "boolean" ? f.in_app : undefined,
  };
}

function scrubException(x: Exception): Exception {
  const type = typeof x.type === "string" && EXCEPTION_TYPE.test(x.type) ? x.type : "Error";
  return {
    type,
    value: safeText(x.value, type),
    mechanism: x.mechanism
      ? { type: ok<string>(x.mechanism.type, re(MECHANISM_TYPE)) ?? "generic", handled: typeof x.mechanism.handled === "boolean" ? x.mechanism.handled : undefined }
      : undefined,
    stacktrace: Array.isArray(x.stacktrace?.frames) ? { frames: x.stacktrace!.frames!.slice(-100).map(scrubFrame) } : undefined,
  };
}

/** Source-map ids: type, file (normalised as frames are) and debug id; nothing else. */
function scrubDebugMeta(d: ErrorEvent["debug_meta"]): ErrorEvent["debug_meta"] | undefined {
  if (!d || !Array.isArray(d.images)) return undefined;
  const images = d.images.flatMap((img) => {
    const i = img as { type?: unknown; code_file?: unknown; debug_id?: unknown };
    const file = safeFile(i.code_file);
    if (i.type !== "sourcemap" || !file || !isBuildFile(file) || typeof i.debug_id !== "string" || !DEBUG_ID.test(i.debug_id)) return [];
    return [{ type: "sourcemap" as const, code_file: file, debug_id: i.debug_id }];
  });
  return images.length ? { images: images.slice(0, 200) } : undefined;
}

function scrubContext(kind: keyof typeof CONTEXT_NAMES, c: unknown): { name: string; version?: string } | undefined {
  if (!c || typeof c !== "object") return undefined;
  const o = c as Record<string, unknown>;
  const name = ok<string>(o.name, (x) => CONTEXT_NAMES[kind].has(x));
  if (!name) return undefined;   // a version means nothing without a known name
  return { name, version: ok<string>(o.version, re(CONTEXT_VERSION)) };
}

/** Network and navigation breadcrumbs only, reduced to method, normalised URL and status. */
export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb | null {
  const d = (b.data ?? {}) as Record<string, unknown>;
  const level = ok<Breadcrumb["level"]>(b.level, (x) => LEVELS.has(x));
  if (b.category === "navigation") {
    return { category: "navigation", timestamp: time(b.timestamp), data: { from: normalizeUrl(d.from), to: normalizeUrl(d.to) } };
  }
  if (b.category === "fetch" || b.category === "xhr" || b.type === "http") {
    return {
      type: "http", category: b.category === "xhr" ? "xhr" : "fetch", timestamp: time(b.timestamp), level,
      data: { method: ok<string>(d.method, (x) => METHODS.has(x)), url: normalizeUrl(d.url), status_code: count(d.status_code, 600) },
    };
  }
  return null;
}

/** Rebuilds an event from the allowlist. Returns null to drop it. */
export function scrubEvent(e: ErrorEvent): ErrorEvent | null {
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.tags ?? {})) {
    const valid = TAG_VALUE[k];
    if (valid && (typeof v === "string" || typeof v === "number") && valid(String(v))) tags[k] = String(v);
  }

  const contexts: NonNullable<ErrorEvent["contexts"]> = {};
  for (const k of ["browser", "os", "runtime"] as const) {
    const c = scrubContext(k, e.contexts?.[k]);
    if (c) contexts[k] = c;
  }
  const t = e.contexts?.trace;
  if (t && TRACE_ID.test(String(t.trace_id)) && SPAN_ID.test(String(t.span_id))) contexts.trace = { trace_id: t.trace_id, span_id: t.span_id };

  const sdk = e.sdk && SDK_NAME.test(String(e.sdk.name)) && VERSION.test(String(e.sdk.version))
    ? { name: e.sdk.name, version: e.sdk.version } : undefined;

  const out: ErrorEvent = {
    type: undefined,
    event_id: ok<string>(e.event_id, re(EVENT_ID)),
    timestamp: time(e.timestamp),
    platform: ok<string>(e.platform, re(/^[a-z]{1,20}$/)),
    level: ok<ErrorEvent["level"]>(e.level, (x) => LEVELS.has(x)),
    environment: ok<string>(e.environment, (x) => ENVIRONMENTS.has(x)),
    release: ok<string>(e.release, re(RELEASE)),
    sdk,
    debug_meta: scrubDebugMeta(e.debug_meta),
    transaction: normalizeTransaction(e.transaction),
    tags,
    contexts,
    // No user data, and none for Sentry to add: Sentry fills in user.geo (city, region, country) from the sender's
    // connection whenever the event has none, even with infer_ip "never" and IP storage off. An empty geo stops it
    // (tested against Sentry on staging, 22 Nov: without it the tester's city was stored; with it, no user data).
    user: { ip_address: null, geo: {} },
    // fingerprint, dist, server_name, extra, modules and every other field: never sent
  };
  if (e.message !== undefined) out.message = safeText(e.message);
  if (e.logentry) out.logentry = { message: safeText(e.logentry.message) };
  if (Array.isArray(e.exception?.values)) out.exception = { values: e.exception!.values!.slice(0, 10).map(scrubException) };
  if (e.request) out.request = { method: ok<string>(e.request.method, (x) => METHODS.has(x)), url: normalizeUrl(e.request.url) };
  if (Array.isArray(e.breadcrumbs)) out.breadcrumbs = e.breadcrumbs.map(scrubBreadcrumb).filter((b): b is Breadcrumb => b !== null);
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
/**
 * What the SDK itself collects (SDK 11 `dataCollection`; the older `sendDefaultPii` no longer exists and was ignored).
 * Everything off. Most of it never reached Sentry anyway (beforeSend drops it), but `userInfo` also decides whether
 * Sentry is asked to infer the sender's IP address ("infer_ip"), outside beforeSend: left on, Sentry stored the
 * tester's city on the staging browser events (22 Nov). Off, the browser sends `infer_ip: "never"`.
 */
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
} satisfies DataCollection;

export function baseOptions(dsn: string | undefined, environment: string) {
  return {
    dsn,
    enabled: !!dsn,
    environment,
    dataCollection: DATA_COLLECTION,
    tracesSampleRate: 0,
    maxBreadcrumbs: 30,
    ignoreErrors: IGNORE_ERRORS,
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
    beforeBreadcrumb: (b: Breadcrumb) => scrubBreadcrumb(b),
    integrations: <I extends { name: string }>(defaults: I[]) => defaults.filter((i) => !DROPPED_INTEGRATIONS.has(i.name)),
  };
}
