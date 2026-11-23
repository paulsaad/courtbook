const mockInit = jest.fn();
jest.mock("@sentry/react-native", () => ({ init: (o: unknown) => mockInit(o), wrap: (c: unknown) => c, captureException: jest.fn(), captureMessage: jest.fn(), addBreadcrumb: jest.fn(), setExtra: jest.fn(), setContext: jest.fn(), setTag: jest.fn(), nativeCrash: jest.fn() }));
jest.mock("expo-updates", () => ({ updateId: "upd-1" }));
jest.mock("expo-application", () => ({ applicationId: "app.courtbook.mobile.staging", nativeApplicationVersion: "0.3.0", nativeBuildVersion: "7" }));
import type { ErrorEvent } from "@sentry/react-native";
import { maskEmails, PROBE_VALUES, safeText, safeUrl, scrubBreadcrumb, scrubEvent, startCrashReporting } from "../lib/crash";

const P = PROBE_VALUES;
const NEEDLES = [P.name, "Probe", "Personname", P.email, "probe.person", P.phone, "70 123 456", "70123456", P.id, P.token, "1.2.3.4", "Bearer", "Pauls-iPhone", "Paul's iPhone", "Asia/Beirut", "device_app_hash"];
const leaks = (v: unknown) => NEEDLES.filter((n) => JSON.stringify(v).includes(n));

/** An event shaped like what the React Native SDK hands to beforeSend, with personal data in every field. */
const dirtyEvent = () => ({
  event_id: "abc123", timestamp: 1, platform: "javascript", level: "error", environment: "staging",
  release: "app.courtbook.mobile.staging@0.3.0+12", dist: "12", sdk: { name: "sentry.javascript.react-native", version: "8.28.0", integrations: ["x"] },
  message: `message for ${P.name} ${P.email}`,
  exception: { values: [{
    type: "Error", value: `Booking failed for ${P.name} (${P.email}, ${P.phone}) id ${P.id}`, mechanism: { type: "generic", handled: true, data: { who: P.name } },
    stacktrace: { frames: [
      { filename: "app:///index.android.bundle", function: "reserve", lineno: 10, colno: 3, in_app: true, vars: { email: P.email }, context_line: `const who = "${P.name}"`, pre_context: [P.phone] },
      { filename: `/data/user/0/app/${P.id}/x.js`, function: `fn ${P.email}`, lineno: 2 },
    ] },
  }] },
  user: { id: "u1", email: P.email, ip_address: "1.2.3.4", username: P.name },
  server_name: "Pauls-iPhone",
  extra: { probe: { name: P.name } },
  tags: { update_id: "01a1fe69-33d3-7615-948d-c7de6efd64e7", probe_name: P.name, event: "x" },
  contexts: {
    device: { name: "Paul's iPhone", model: "iPhone15,2", family: "iOS", timezone: "Asia/Beirut", device_app_hash: "deadbeef" },
    os: { name: "Android", version: "15", kernel_version: "Linux version 6.1 (builder@host)" },
    app: { app_identifier: "app.courtbook.mobile.staging", app_version: "0.3.0", app_build: "12", device_app_hash: "deadbeef", app_start_time: "2026" },
    culture: { locale: "en_LB", timezone: "Asia/Beirut" },
    probe: { phone: P.phone },
    trace: { trace_id: "t" },
  },
  request: { url: `https://x.supabase.co/rest/v1/bookings/${P.id}?client_token=eq.${P.token}`, method: "GET", headers: { Authorization: "Bearer t" }, cookies: { a: "b" }, data: { email: P.email } },
  breadcrumbs: [
    { category: "console", message: `signed in as ${P.name} <${P.email}> ${P.phone}`, level: "log" },
    { category: "touch", message: P.name },
    { category: "ui.click", message: P.name },
    { category: "navigation", data: { from: `/profile?email=${P.email}`, to: `/booking/${P.id}?token=${P.token}` } },
    { category: "fetch", type: "http", data: { method: "POST", url: `https://x.supabase.co/rest/v1/people/${P.email}/${P.id}?phone=${P.phone}`, status_code: 400, body: P.name } },
    { category: "device.event", message: `low memory ${P.name}` },
    { category: "app.lifecycle", data: { state: "foreground" } },
  ],
  modules: { x: "1" },
  fingerprint: [P.name],
  debug_meta: { images: [{ type: "sourcemap", debug_id: "11111111-2222-3333-4444-555555555555", code_file: "app:///index.android.bundle" }, { type: "macho", code_file: `/private/var/containers/Bundle/Application/${P.id}/CourtBook.app/CourtBook` }] },
});

describe("crash reports: no free text, an allowlist of fields (M5 review)", () => {
  it("synthetic personal data in every field: none of it survives", () => {
    const s = scrubEvent(dirtyEvent() as unknown as ErrorEvent);
    expect(leaks(s)).toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });

  it("keeps what is needed to fix the bug: release, type, stack, codes, screen path, app/os/device model, update id", () => {
    const s = scrubEvent(dirtyEvent() as unknown as ErrorEvent) as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys(s).sort()).toEqual(["breadcrumbs", "contexts", "debug_meta", "dist", "environment", "event_id", "exception", "level", "message", "platform", "release", "request", "sdk", "tags", "timestamp"]);
    expect(s.release).toBe("app.courtbook.mobile.staging@0.3.0+12");
    expect(s.message).toBe("[withheld]");
    expect(s.exception.values[0]).toEqual({ type: "Error", value: "[withheld]", mechanism: { type: "generic", handled: true },
      stacktrace: { frames: [{ filename: "app:///index.android.bundle", function: "reserve", lineno: 10, colno: 3, in_app: true }, { filename: "/data/user/0/app/:id/x.js", lineno: 2 }] } });
    expect(s.tags).toEqual({ update_id: "01a1fe69-33d3-7615-948d-c7de6efd64e7" });
    expect(s.contexts).toEqual({ device: { model: "iPhone15,2", family: "iOS" }, os: { name: "Android", version: "15" }, app: { app_identifier: "app.courtbook.mobile.staging", app_version: "0.3.0", app_build: "12" } });
    expect(s.request).toEqual({ url: "https://x.supabase.co/rest/v1/bookings/:id", method: "GET" });
    expect(s.breadcrumbs).toEqual([
      { category: "navigation", data: { from: "/profile", to: "/booking/:id" } },
      { type: "http", category: "fetch", data: { method: "POST", url: "https://x.supabase.co/rest/v1/people/[email]/:id", status_code: 400 } },
    ]);
    expect(s.debug_meta).toEqual({ images: [{ type: "sourcemap", debug_id: "11111111-2222-3333-4444-555555555555", code_file: "app:///index.android.bundle" }] });
    for (const k of ["user", "server_name", "extra", "modules", "fingerprint"]) expect(s[k]).toBeUndefined();
  });

  it("messages: only our fixed messages, error codes and connection failures pass; everything else is withheld", () => {
    expect(safeText("CourtBook test report (staging)")).toBe("CourtBook test report (staging)");
    expect(safeText("CourtBook privacy probe")).toBe("CourtBook privacy probe");
    expect(safeText("slot_taken")).toBe("slot_taken");
    expect(safeText("Network request failed")).toBe("Network request failed");
    expect(safeText("Minified React error #418; visit https://react.dev/errors/418?args[]=Paul")).toBe("Minified React error #418");
    for (const t of ["Paul", "Couldn't load Rami Haddad", "slot taken for Paul", "duplicate key (email)=(a@b.co)", "+96170123456", undefined, 42]) expect(safeText(t)).toBe("[withheld]");
  });

  it("URLs: no query, fragment, IDs, tokens, phone numbers or emails", () => {
    expect(safeUrl("/booking/3f6e2b1c-9a4d-4c2e-8b7f-1a2b3c4d5e6f?token=x#y")).toBe("/booking/:id");
    expect(safeUrl("https://x.supabase.co/rest/v1/rpc/hold_slot")).toBe("https://x.supabase.co/rest/v1/rpc/hold_slot");
    expect(safeUrl("/club/batroun/info")).toBe("/club/batroun/info");
    expect(safeUrl("/coach/12345")).toBe("/coach/:id");
    expect(safeUrl(`/x/${"a".repeat(30)}`)).toBe("/x/:id");
    expect(safeUrl("/u/p@x.com/a")).toBe("/u/[email]/a");
    expect(safeUrl("/call/+961 70 123 456")).toBe("/call/:id");
    expect(safeUrl("/q/Rami Haddad")).toBe("/q/:redacted");
    // scrubbed twice (as the breadcrumb is recorded, then in the report): same result (seen on staging, 23 Nov)
    for (const u of ["/booking/3f6e2b1c-9a4d-4c2e-8b7f-1a2b3c4d5e6f?t=x", "https://x.supabase.co/rest/v1/people/p@x.com/12345", "/q/Rami Haddad"]) expect(safeUrl(safeUrl(u))).toBe(safeUrl(u));
  });

  it("breadcrumbs are filtered as they are recorded (so the native layer's copy is clean too): navigation and HTTP only", () => {
    expect(scrubBreadcrumb({ category: "console", message: P.email })).toBeNull();
    expect(scrubBreadcrumb({ category: "touch", message: "Emma Tester" })).toBeNull();
    expect(scrubBreadcrumb({ category: "ui.click", message: "x" })).toBeNull();
    expect(scrubBreadcrumb({ category: "device.event", message: "x" })).toBeNull();
    expect(scrubBreadcrumb({ message: `free text ${P.name}` })).toBeNull();
    expect(scrubBreadcrumb({ category: "navigation", data: { to: `/booking/${P.id}` } })).toEqual({ category: "navigation", data: { from: undefined, to: "/booking/:id" } });
  });

  it("maskEmails still masks addresses in any value", () => {
    expect(maskEmails({ a: ["x@y.co"] })).toEqual({ a: ["[email]"] });
  });
});

describe("configuration", () => {
  beforeEach(() => mockInit.mockClear());

  it("is off without a DSN", () => {
    expect(startCrashReporting("")).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("tags the app, version, build and update; no default personal data, no sessions, no automatic native breadcrumbs", () => {
    expect(startCrashReporting("https://key@o1.ingest.sentry.io/2")).toBe(true);
    const o = mockInit.mock.calls[0][0];
    expect(o).toMatchObject({
      environment: "staging", release: "app.courtbook.mobile.staging@0.3.0+7", dist: "7", initialScope: { tags: { update_id: "upd-1" } },
      sendDefaultPii: false, attachScreenshot: false, attachViewHierarchy: false, attachThreads: false, tracesSampleRate: 0,
      enableAutoSessionTracking: false, enableAutoBreadcrumbTracking: false, enableNetworkBreadcrumbs: false, enableNetworkEventBreadcrumbs: false,
      enableSystemEventBreadcrumbs: false, enableAppComponentBreadcrumbs: false, enableActivityLifecycleBreadcrumbs: false,
      enableAppLifecycleBreadcrumbs: false, enableCaptureFailedRequests: false,
    });
    expect(leaks(o.beforeSend(dirtyEvent()))).toEqual([]);
    expect(o.beforeBreadcrumb({ category: "console", message: P.email })).toBeNull();
  });
});
