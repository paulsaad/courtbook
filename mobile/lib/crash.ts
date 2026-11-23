import * as Sentry from "@sentry/react-native";
import type { Breadcrumb, ErrorEvent } from "@sentry/react-native";
import * as Updates from "expo-updates";
import * as Application from "expo-application";
import { installedVariant } from "./appIdentity";

/**
 * Crash and error reports from real phones (Sentry). Off unless EXPO_PUBLIC_SENTRY_DSN is set, so a
 * build without it behaves exactly as before.
 *
 * Principle (M5 review, 23 Nov 2026 — the website's rule since W2a): NO FREE TEXT LEAVES THE PHONE.
 * A message can carry a name, a phone number or a booking in a shape no pattern would catch, so text is
 * not masked — it is WITHHELD unless it is one of our own fixed messages or an error code. Every event
 * is rebuilt from an allowlist (scrubEvent); nothing not listed below is sent:
 *   - message / exception value: a fixed message (SAFE_MESSAGES), a code (`slot_taken`), a known
 *     platform message (NETWORK_MESSAGES), or "[withheld]"; exception type only if identifier-shaped;
 *   - stack frames: file, function, line, column (paths with IDs and emails rewritten); no variables,
 *     no source lines;
 *   - URLs everywhere: no query string, no fragment; IDs, tokens and emails in the path replaced;
 *   - breadcrumbs (also filtered as they are recorded, so the copy the native layer keeps for a native
 *     crash is clean too): navigation and HTTP only (method, URL as above, status). Console output,
 *     taps, messages and every other kind are dropped;
 *   - tags: update_id only; contexts: os, device, app, runtime, react-native — named fields only, short
 *     identifier-shaped values; no device name, no time zone, no locale, no device hash;
 *   - never: user, IP address, server name, extra, request body/headers/cookies, modules, fingerprint.
 * Native side: no sessions (they carry an installation id), no automatic native breadcrumbs. A native
 * crash is built by the native SDK (beforeSend does not run there); it carries the already-filtered
 * breadcrumbs, the device contexts and the stack. What Sentry received is checked on staging
 * (docs/m5/crash-privacy.md).
 */

/** Our own fixed messages: they never contain anything about a person. */
export const SAFE_MESSAGES = new Set<string>([
  "CourtBook test report (staging)", "CourtBook test report (production)", "CourtBook test report (development)",
  "CourtBook privacy probe",
]);
/** Platform messages with no personal content (connection failures). */
const NETWORK_MESSAGES = new Set(["Network request failed", "Network request timed out", "Aborted", "The operation was aborted.", "Load failed"]);
const CODE = /^[a-z][a-z0-9_]{2,63}$/;
const MINIFIED_REACT = /^Minified React error #\d+/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const HAS_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;   // no "g": .test() keeps no state
const IDENT = /^[A-Za-z_$][\w$.]{0,80}$/;
const SHORT = /^[\w .,:+()/@-]{1,80}$/;

export function safeText(v: unknown): string {
  if (typeof v !== "string") return "[withheld]";
  if (SAFE_MESSAGES.has(v) || NETWORK_MESSAGES.has(v) || CODE.test(v)) return v;
  const react = v.match(MINIFIED_REACT);
  return react ? react[0] : "[withheld]";
}

/** A URL or path with no query, fragment, IDs, tokens or email addresses. */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const noQuery = v.split(/[?#]/)[0].replace(EMAIL, "[email]");
  const m = noQuery.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/i);
  const origin = m?.[1] ?? "";
  const path = (m?.[2] ?? "").split("/").map((seg) => {
    if (seg === "" || seg === "[email]") return seg;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
    if (/^\d{3,}$/.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg)) return ":id";
    if (/\+?\d[\d\s-]{6,}/.test(seg)) return ":id";
    return /^[\w.@()[\]~+-]{1,80}$/.test(seg) ? seg : ":redacted";
  }).join("/");
  return origin + path;
}

const shortValue = (v: unknown) => (typeof v === "string" && SHORT.test(v) && !HAS_EMAIL.test(v) ? v : typeof v === "number" || typeof v === "boolean" ? v : undefined);
function pick(src: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!src || typeof src !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = shortValue((src as Record<string, unknown>)[k]);
    if (v !== undefined) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
const CONTEXT_FIELDS: Record<string, string[]> = {
  os: ["name", "version", "build"],
  device: ["family", "model", "model_id", "arch", "manufacturer", "brand", "simulator"],
  app: ["app_identifier", "app_version", "app_build", "build_type"],
  runtime: ["name", "version"],
  react_native_context: ["js_engine", "react_native_version", "hermes_version", "expo"],
};

type Frame = { filename?: string; abs_path?: string; function?: string; lineno?: number; colno?: number; in_app?: boolean; platform?: string; module?: string };
function safeFrame(f: Frame): Frame {
  const out: Frame = {};
  const file = safeUrl(f.filename); if (file) out.filename = file;
  const abs = safeUrl(f.abs_path); if (abs) out.abs_path = abs;
  // A code identifier only (e.g. "reserve", "Object.<anonymous>", "?anon_0_"): no spaces, no "@", so no free text.
  if (typeof f.function === "string" && /^[\w$.<>[\]?:-]{1,120}$/.test(f.function)) out.function = f.function;
  if (typeof f.module === "string" && IDENT.test(f.module)) out.module = f.module;
  if (typeof f.lineno === "number") out.lineno = f.lineno;
  if (typeof f.colno === "number") out.colno = f.colno;
  if (typeof f.in_app === "boolean") out.in_app = f.in_app;
  if (typeof f.platform === "string" && IDENT.test(f.platform)) out.platform = f.platform;
  return out;
}

export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb | null {
  const base = { ...(b.type ? { type: b.type } : {}), ...(b.level ? { level: b.level } : {}), ...(b.timestamp ? { timestamp: b.timestamp } : {}) };
  if (b.category === "navigation") {
    const d = (b.data ?? {}) as Record<string, unknown>;
    return { ...base, category: "navigation", data: { from: safeUrl(d.from), to: safeUrl(d.to) } };
  }
  if (b.category === "fetch" || b.category === "xhr" || b.type === "http") {
    const d = (b.data ?? {}) as Record<string, unknown>;
    const method = typeof d.method === "string" && /^[A-Z]{3,7}$/.test(d.method) ? d.method : undefined;
    const status = typeof d.status_code === "number" ? d.status_code : undefined;
    return { ...base, category: b.category ?? "http", data: { method, url: safeUrl(d.url), status_code: status } };
  }
  return null; // console output, taps, messages, lifecycle and everything else
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const e = event as ErrorEvent & Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["event_id", "timestamp", "platform", "level", "environment", "release", "dist"]) if (e[k] !== undefined) out[k] = e[k];
  if (e.sdk) out.sdk = { name: e.sdk.name, version: e.sdk.version };
  if (e.message !== undefined) out.message = safeText(e.message);
  if (e.exception?.values) {
    out.exception = {
      values: e.exception.values.map((x) => ({
        type: typeof x.type === "string" && IDENT.test(x.type) ? x.type : "Error",
        value: safeText(x.value),
        ...(x.mechanism ? { mechanism: { type: x.mechanism.type, handled: x.mechanism.handled } } : {}),
        ...(x.stacktrace?.frames ? { stacktrace: { frames: (x.stacktrace.frames as Frame[]).map(safeFrame) } } : {}),
      })),
    };
  }
  const updateId = e.tags?.update_id;
  if (typeof updateId === "string" && /^([0-9a-f-]{36}|built-in)$/.test(updateId)) out.tags = { update_id: updateId };
  const contexts: Record<string, unknown> = {};
  for (const [name, keys] of Object.entries(CONTEXT_FIELDS)) {
    const c = pick(e.contexts?.[name], keys);
    if (c) contexts[name] = c;
  }
  if (Object.keys(contexts).length) out.contexts = contexts;
  if (e.breadcrumbs) out.breadcrumbs = e.breadcrumbs.map(scrubBreadcrumb).filter((b): b is Breadcrumb => b !== null);
  if (e.request) out.request = { url: safeUrl(e.request.url), method: typeof e.request.method === "string" && /^[A-Z]{3,7}$/.test(e.request.method) ? e.request.method : undefined };
  if (typeof e.transaction === "string") out.transaction = safeUrl(e.transaction);
  const images = (e.debug_meta?.images ?? []).filter((i) => i.type === "sourcemap" && typeof (i as { debug_id?: string }).debug_id === "string");
  if (images.length) out.debug_meta = { images: images.map((i) => ({ type: "sourcemap", debug_id: (i as { debug_id: string }).debug_id, code_file: safeUrl((i as { code_file?: string }).code_file) })) };
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
