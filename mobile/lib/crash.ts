import * as Sentry from "@sentry/react-native";
import type { Breadcrumb, ErrorEvent } from "@sentry/react-native";
import * as Updates from "expo-updates";
import * as Application from "expo-application";
import { installedVariant } from "./appIdentity";
import { ERRORS } from "@shared/types";
import { GAME_ERRORS } from "./gameErrors";

/**
 * Crash and error reports from real phones (Sentry). Off unless EXPO_PUBLIC_SENTRY_DSN is set, so a
 * build without it behaves exactly as before.
 *
 * Principle (M5 review, 23 Nov 2026 — the website's rule since W2a): NO FREE TEXT LEAVES THE PHONE.
 * A message can carry a name, a phone number or a booking in a shape no pattern would catch, so text is
 * not masked — it is WITHHELD unless it is one of our own fixed messages or an error code. Every event
 * is rebuilt from an allowlist (scrubEvent); nothing not listed below is sent:
 *   - message / exception value: a fixed message (SAFE_MESSAGES), an error code the app knows (KNOWN_CODES:
 *     shared ERRORS + GAME_ERRORS), a known connection failure, the React error number, or "[withheld]";
 *     exception type only if it is an error class name ("TypeError"), else "Error";
 *   - stack frames: bundle file name, function, line, column; no variables, no source lines;
 *   - URLs everywhere are route templates: a known host or "[host]", no query or fragment, and only segments the
 *     app defines (its screens, the Supabase API words, tables and RPCs it calls); every other segment is ":id";
 *   - breadcrumbs (also filtered as they are recorded, so the copy the native layer keeps for a native
 *     crash is clean too): navigation and HTTP only (method, URL as above, status). Console output,
 *     taps, messages and every other kind are dropped;
 *   - tags: update_id only; contexts: os, device, app, runtime, react-native — each field with its own rule
 *     (FIELDS); no device name, manufacturer, time zone, locale or device hash;
 *   - never: user, IP address, server name, extra, request body/headers/cookies, modules, fingerprint.
 * Native side: no sessions (they carry an installation id), no automatic native breadcrumbs. A native
 * crash is built by the native SDK (beforeSend does not run there): it carries the already-filtered
 * breadcrumbs, but also an installation ID, language, time zone, device state and the system's own
 * error text — verified on staging, 23 Nov (docs/m5/crash-privacy.md). Decided 23 Nov: declared in the
 * stores, not removed by a native filter.
 */

/** Our own fixed messages: they never contain anything about a person. */
export const SAFE_MESSAGES = new Set<string>([
  "CourtBook test report (staging)", "CourtBook test report (production)", "CourtBook test report (development)",
  "CourtBook privacy probe",
]);
/** Platform messages with no personal content (connection failures). */
const NETWORK_MESSAGES = new Set(["Network request failed", "Network request timed out", "Aborted", "The operation was aborted.", "Load failed"]);
/**
 * Error codes the server can raise, as the app already knows them (shared ERRORS + GAME_ERRORS). Only these pass as
 * text: an arbitrary lowercase word ("rami", "x7k2p9") is withheld (M5 review 2, 23 Nov).
 */
export const KNOWN_CODES = new Set<string>([...Object.keys(ERRORS), ...Object.keys(GAME_ERRORS)]);
const MINIFIED_REACT = /^Minified React error #\d+/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const IDENT = /^[A-Za-z_$][\w$.]{0,80}$/;
/** Exception class names: "Error", "TypeError", "AuthApiError", "PostgrestError"… never a bare word such as a name. */
const ERROR_TYPE = /^[A-Z][A-Za-z]{0,60}(Error|Exception)$/;

export function safeText(v: unknown): string {
  if (typeof v !== "string") return "[withheld]";
  if (SAFE_MESSAGES.has(v) || NETWORK_MESSAGES.has(v) || KNOWN_CODES.has(v)) return v;
  const react = v.match(MINIFIED_REACT);
  return react ? react[0] : "[withheld]";
}

/**
 * Route templates. A path keeps only segments the app itself defines: its screen names (mobile/app) and the names of
 * the server calls it makes (Supabase API words, tables, RPCs). Every other segment (an ID, a club, a name, a
 * token) becomes ":id". Tests keep these lists in step with the code; a name missing here is only shown as ":id".
 */
export const ROUTE_SEGMENTS = new Set([
  "activity", "areas", "booking", "bookings", "chat", "club", "courts", "design-preview", "e2e-games", "edit", "game", "games",
  "help", "match", "post", "profile", "sign-in",
]);
export const API_SEGMENTS = new Set([
  "rest", "auth", "functions", "storage", "v1", "rpc", "object", "public", "sign", "token", "user", "otp", "verify",
  "logout", "recover", "authorize", "callback", "settings", "health",
  // tables
  "bookings", "club_media", "clubs", "courts", "match_messages", "matches", "notifications", "payments", "price_rules",
  "profiles", "sports", "towns",
  // RPCs
  // M2 (0086) and M14 (0087–0089), added when #14 met #18/#19 in the release candidate
  "close_my_account", "club_discovery", "dismiss_areas_question", "my_favourite_clubs", "my_playing_prefs",
  "set_club_favourite", "set_last_area", "set_playing_areas",
  "accept_community_rules", "areas", "block_player", "book_at_desk", "booking_match", "cancel_account_deletion",
  "cancel_booking", "club_day_slots", "confirm_age", "delete_match_message", "hold_slot", "mark_notifications_read",
  "match_board", "match_detail", "match_messages_list", "match_participants", "my_account_deletion",
  "my_account_status", "my_age_status", "my_agenda", "my_blocked_players", "my_levels", "my_recent_players",
  "my_rules_accepted", "open_matches", "post_match", "quote_price", "report_content", "request_account_deletion",
  "send_feedback", "unblock_player",
]);
const KNOWN_HOST = /^(?:[a-z0-9-]+\.supabase\.co|u\.expo\.dev|courtbook-three\.vercel\.app)$/;

/** A URL or path as a template: known host or "[host]", no query or fragment, unknown segments as ":id". */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.split(/[?#]/)[0].match(/^(?:([a-z][a-z0-9+.-]*):\/\/([^/]*))?(.*)$/i);
  if (!m) return undefined;
  const [, scheme, host, rest] = m;
  const origin = scheme === undefined ? "" : `${scheme}://${KNOWN_HOST.test(host.toLowerCase()) ? host.toLowerCase() : "[host]"}`;
  const known = scheme === undefined ? ROUTE_SEGMENTS : origin.endsWith("[host]") ? new Set<string>() : API_SEGMENTS;   // unknown host: nothing kept
  const path = rest.split("/").map((seg) => (seg === "" || seg === ":id" || known.has(seg) ? seg : ":id")).join("/");
  return origin + path;
}

/** Stack-frame file names: the JavaScript bundle (or a source path after symbolication) and nothing else. */
function safeFile(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (/^(app:\/\/\/)?[\w.-]{1,80}\.(bundle|jsbundle|hbc|js)$/.test(v) || v === "[native code]" || v === "native") return v;
  return "[file]";
}

/** Device fields, each with its own rule (no generic "short string"). */
const VERSION = /^\d{1,4}(\.\d{1,6}){0,3}$/;
const FIELDS: Record<string, Record<string, (v: unknown) => boolean>> = {
  os: {
    name: (v) => v === "Android" || v === "iOS" || v === "iPadOS",
    version: (v) => typeof v === "string" && VERSION.test(v),
    build: (v) => typeof v === "string" && /^[A-Z0-9][A-Za-z0-9._]{2,20}$/.test(v),        // "22A3354", "SE1A.220826.006"
  },
  device: {
    family: (v) => v === "Android" || v === "iOS" || v === "iPhone" || v === "iPad",
    model: (v) => typeof v === "string" && /^(?=.*\d)[A-Za-z0-9 ,._()+-]{2,40}$/.test(v),   // a model always has a digit: "iPhone15,2", "SM-A175F", "Pixel 6"
    model_id: (v) => typeof v === "string" && /^[A-Za-z0-9._,-]{2,40}$/.test(v) && /\d/.test(v),
    arch: (v) => typeof v === "string" && /^(arm64|arm64e|arm64-v8a|armeabi-v7a|x86|x86_64)$/.test(v),
    simulator: (v) => typeof v === "boolean",
  },
  app: {
    app_identifier: (v) => v === "app.courtbook.mobile" || v === "app.courtbook.mobile.staging",
    app_version: (v) => typeof v === "string" && VERSION.test(v),
    app_build: (v) => typeof v === "string" && /^\d{1,9}$/.test(v),
  },
  runtime: {
    name: (v) => v === "hermes" || v === "Hermes" || v === "jsc",
    version: (v) => typeof v === "string" && /^[\d.]{1,30}$/.test(v),
  },
  react_native_context: {
    js_engine: (v) => v === "hermes" || v === "jsc",
    react_native_version: (v) => typeof v === "string" && VERSION.test(v),
    hermes_version: (v) => typeof v === "string" && /^[\d.]{1,30}$/.test(v),
    expo: (v) => typeof v === "boolean",
  },
};
function pickContext(src: unknown, rules: Record<string, (v: unknown) => boolean>): Record<string, unknown> | undefined {
  if (!src || typeof src !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, ok] of Object.entries(rules)) {
    const v = (src as Record<string, unknown>)[k];
    if (ok(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

type Frame = { filename?: string; abs_path?: string; function?: string; lineno?: number; colno?: number; in_app?: boolean; platform?: string; module?: string };
function safeFrame(f: Frame): Frame {
  const out: Frame = {};
  const file = safeFile(f.filename); if (file) out.filename = file;
  const abs = safeFile(f.abs_path); if (abs) out.abs_path = abs;
  // A code identifier only (e.g. "reserve", "Object.<anonymous>", "?anon_0_"): no spaces, no "@", so no free text.
  if (typeof f.function === "string" && /^[\w$.<>[\]?:-]{1,120}$/.test(f.function)) out.function = f.function;
  if (typeof f.module === "string" && IDENT.test(f.module)) out.module = f.module;
  if (typeof f.lineno === "number") out.lineno = f.lineno;
  if (typeof f.colno === "number") out.colno = f.colno;
  if (typeof f.in_app === "boolean") out.in_app = f.in_app;
  if (typeof f.platform === "string" && IDENT.test(f.platform)) out.platform = f.platform;
  return out;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb | null {
  const base = { ...(b.type ? { type: b.type } : {}), ...(b.level ? { level: b.level } : {}), ...(b.timestamp ? { timestamp: b.timestamp } : {}) };
  if (b.category === "navigation") {
    const d = (b.data ?? {}) as Record<string, unknown>;
    return { ...base, category: "navigation", data: { from: safeUrl(d.from), to: safeUrl(d.to) } };
  }
  if (b.category === "fetch" || b.category === "xhr" || b.type === "http") {
    const d = (b.data ?? {}) as Record<string, unknown>;
    const method = typeof d.method === "string" && HTTP_METHODS.has(d.method) ? d.method : undefined;
    const status = typeof d.status_code === "number" ? d.status_code : undefined;
    return { ...base, category: b.category ?? "http", data: { method, url: safeUrl(d.url), status_code: status } };
  }
  return null; // console output, taps, messages, lifecycle and everything else
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const e = event as ErrorEvent & Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["event_id", "timestamp", "environment", "release", "dist"]) if (e[k] !== undefined) out[k] = e[k];
  if (e.platform === "javascript" || e.platform === "native") out.platform = e.platform;
  if (typeof e.level === "string" && ["fatal", "error", "warning", "log", "info", "debug"].includes(e.level)) out.level = e.level;
  if (e.sdk) out.sdk = { name: e.sdk.name, version: e.sdk.version };
  if (e.message !== undefined) out.message = safeText(e.message);
  if (e.exception?.values) {
    out.exception = {
      values: e.exception.values.map((x) => ({
        type: typeof x.type === "string" && ERROR_TYPE.test(x.type) ? x.type : "Error",
        value: safeText(x.value),
        ...(x.mechanism ? { mechanism: { type: x.mechanism.type, handled: x.mechanism.handled } } : {}),
        ...(x.stacktrace?.frames ? { stacktrace: { frames: (x.stacktrace.frames as Frame[]).map(safeFrame) } } : {}),
      })),
    };
  }
  const updateId = e.tags?.update_id;
  if (typeof updateId === "string" && /^([0-9a-f-]{36}|built-in)$/.test(updateId)) out.tags = { update_id: updateId };
  const contexts: Record<string, unknown> = {};
  for (const [name, rules] of Object.entries(FIELDS)) {
    const c = pickContext(e.contexts?.[name], rules);
    if (c) contexts[name] = c;
  }
  if (Object.keys(contexts).length) out.contexts = contexts;
  if (e.breadcrumbs) out.breadcrumbs = e.breadcrumbs.map(scrubBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  if (e.request) out.request = { url: safeUrl(e.request.url), method: typeof e.request.method === "string" && HTTP_METHODS.has(e.request.method) ? e.request.method : undefined };
  if (typeof e.transaction === "string") out.transaction = safeUrl(e.transaction);
  const images = (e.debug_meta?.images ?? []).filter((i) => i.type === "sourcemap" && typeof (i as { debug_id?: string }).debug_id === "string");
  if (images.length) out.debug_meta = { images: images.map((i) => ({ type: "sourcemap", debug_id: (i as { debug_id: string }).debug_id, code_file: safeFile((i as { code_file?: string }).code_file) })) };
  return out as unknown as ErrorEvent;
}

/** Kept for the old tests and other callers: masks email addresses in any value. */
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

export function startCrashReporting(dsn = process.env.EXPO_PUBLIC_SENTRY_DSN) {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    environment: installedVariant ?? "development",
    release: `${Application.applicationId ?? "?"}@${Application.nativeApplicationVersion ?? "?"}+${Application.nativeBuildVersion ?? "?"}`,
    dist: Application.nativeBuildVersion ?? undefined,
    initialScope: { tags: { update_id: Updates.updateId ?? "built-in" } },
    tracesSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    attachThreads: false,
    maxBreadcrumbs: 30,
    // M5: no release-health sessions (they carry an installation id) and no automatic native breadcrumbs
    enableAutoSessionTracking: false,
    enableAutoBreadcrumbTracking: false,
    enableNetworkBreadcrumbs: false,
    enableNetworkEventBreadcrumbs: false,
    enableSystemEventBreadcrumbs: false,
    enableAppComponentBreadcrumbs: false,
    enableActivityLifecycleBreadcrumbs: false,
    enableAppLifecycleBreadcrumbs: false,
    enableCaptureFailedRequests: false,
    beforeSend: (event) => {
      const out = scrubEvent(event);
      if (process.env.EXPO_PUBLIC_E2E === "1") logForTests(out);
      return out;
    },
    beforeBreadcrumb: (b) => scrubBreadcrumb(b),
  });
  return true;
}

/**
 * Emulator test builds only: write the exact report that leaves the phone to the device log, in
 * pieces (the log truncates long lines), so the test can check its contents.
 */
function logForTests(event: unknown) {
  const json = JSON.stringify(event);
  const n = Math.ceil(json.length / 3000);
  for (let i = 0; i < n; i++) console.log(`SENTRY_EVENT ${i + 1}/${n} ${json.slice(i * 3000, (i + 1) * 3000)}`);
}

/** For the Test tools: a handled test error, so a report can be checked end to end. */
export function sendTestReport() {
  Sentry.captureException(new Error(`CourtBook test report (${installedVariant ?? "development"})`));
}

/**
 * Emulator test builds only (EXPO_PUBLIC_E2E=1): synthetic personal data in every channel a report can
 * carry, then one error and one message. None of PROBE_VALUES may reach Sentry (e2e/check_report.py on
 * the way out; docs/m5/crash-privacy.md for what Sentry received).
 */
export const PROBE_VALUES = {
  name: "Probe Personname",
  email: "probe.person@example.com",
  phone: "+961 70 123 456",
  id: "3f6e2b1c-9a4d-4c2e-8b7f-1a2b3c4d5e6f",
  token: "probetoken1234567890abcdef",
} as const;
export const E2E_PROBES = process.env.EXPO_PUBLIC_E2E === "1";
export function sendPrivacyProbe() {
  const p = PROBE_VALUES;
  Sentry.addBreadcrumb({ category: "console", message: `signed in as ${p.name} <${p.email}> ${p.phone}` });
  Sentry.addBreadcrumb({ category: "navigation", data: { from: `/profile?email=${p.email}`, to: `/booking/${p.id}?token=${p.token}` } });
  Sentry.addBreadcrumb({ category: "fetch", type: "http", data: { method: "POST", url: `https://x.supabase.co/rest/v1/people/${p.email}/${p.id}?phone=${encodeURIComponent(p.phone)}`, status_code: 400, body: p.name } });
  Sentry.addBreadcrumb({ category: "ui.click", message: p.name });
  Sentry.setExtra("probe", { name: p.name, email: p.email });
  Sentry.setContext("probe", { phone: p.phone });
  Sentry.setTag("probe_name", p.name);
  const err = new Error(`Booking failed for ${p.name} (${p.email}, ${p.phone}) id ${p.id}`);
  Sentry.captureException(err);
  Sentry.captureMessage(`message for ${p.name} ${p.email} ${p.phone}`);
}
/** Emulator test builds only: a native crash, sent by the native SDK on the next launch. */
export function crashNatively() {
  Sentry.addBreadcrumb({ category: "console", message: `before native crash ${PROBE_VALUES.name} ${PROBE_VALUES.email}` });
  Sentry.addBreadcrumb({ category: "navigation", data: { from: "/courts", to: `/booking/${PROBE_VALUES.id}?token=${PROBE_VALUES.token}` } });
  Sentry.nativeCrash();
}

export const wrapRoot = Sentry.wrap;
