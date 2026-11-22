import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import {
  IGNORE_ERRORS, PRIVACY_PROBE, SAFE_MESSAGES, WITHHELD, baseOptions, monitoringEnvironment, normalizePath,
  safeText, scrubBreadcrumb, scrubEvent,
} from "./monitoring";

/** Every piece of fake personal data the probe and these tests use; none may survive scrubbing. */
const SECRETS = ["Jana", "probe@example.invalid", "70 123 456", "482913", "a1b2c3d4-0000-4000-8000-123456789abc",
  "eyJhbGciOiJIUzI1NiJ9.payload.sig", "sb-access-token=xyz", "10.1.2.3", "secret-var-value", "const pin = 4321"];
const leaks = (x: unknown) => SECRETS.filter((s) => JSON.stringify(x).includes(s));

describe("safeText: messages are withheld unless fixed", () => {
  it("keeps our own fixed messages", () => {
    for (const m of Object.values(SAFE_MESSAGES)) expect(safeText(m)).toBe(m);
  });
  it("keeps W1's fixed load errors, as the value of a LoadError only", () => {
    expect(safeText("Couldn't load your bookings", "LoadError")).toBe("Couldn't load your bookings");
    expect(safeText("Couldn't load the club's town", "LoadError")).toBe("Couldn't load the club's town");
    expect(safeText("Couldn't load your bookings")).toBe(WITHHELD);
    expect(safeText("Couldn't load your bookings", "Error")).toBe(WITHHELD);
  });
  it("keeps only the number of a React production error", () => {
    expect(safeText("Minified React error #418; visit https://react.dev/errors/418?args[]=Jana for the full message"))
      .toBe("Minified React error #418");
  });
  it("withholds everything else, however harmless it looks", () => {
    for (const m of [PRIVACY_PROBE, "duplicate key value violates unique constraint",  "booking: unexpected error " + "x", "", "TypeError: x is undefined"])
      expect(safeText(m)).toBe(WITHHELD);
    for (const m of ["Couldn't load Jana's 482913 bookings now", "Couldn't load your bookings: probe@example.invalid"])
      expect(safeText(m, "LoadError")).toBe(WITHHELD);
    expect(safeText(undefined)).toBe(WITHHELD);
    expect(safeText(42)).toBe(WITHHELD);
  });
});

describe("normalizePath: paths only, IDs replaced", () => {
  it("drops query strings and fragments (sign-in codes, emails)", () => {
    expect(normalizePath("https://courtbook-three.vercel.app/auth/callback?code=482913&next=/x#t=1")).toBe("https://courtbook-three.vercel.app/auth/callback");
    expect(normalizePath("/login?email=probe@example.invalid")).toBe("/login");
  });
  it("replaces UUIDs, numbers, token-like and email-like segments", () => {
    expect(normalizePath("/bookings/a1b2c3d4-0000-4000-8000-123456789abc")).toBe("/bookings/:id");
    expect(normalizePath("/pay/A1B2C3D4-0000-4000-8000-123456789ABC/x")).toBe("/pay/:id/x");
    expect(normalizePath("/u/70123456")).toBe("/u/:n");
    expect(normalizePath("/t/eyJhbGciOiJIUzI1NiJ9.payload.sig")).toBe("/t/:token");
    expect(normalizePath("/p/probe@example.invalid")).toBe("/p/:value");
  });
  it("keeps readable route names, including long club slugs", () => {
    expect(normalizePath("/club/tripoli-tennis-and-padel-academy/info")).toBe("/club/tripoli-tennis-and-padel-academy/info");
    expect(normalizePath("/_next/static/chunks/app-page-5f3a.js")).toBe("/_next/static/chunks/app-page-5f3a.js");
  });
  it("ignores non-strings", () => {
    expect(normalizePath(undefined)).toBeUndefined();
    expect(normalizePath(5)).toBeUndefined();
  });
});

/** An event as the SDKs build it, with everything an SDK or a careless call could attach. */
function dirtyEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: "e1",
    timestamp: 1,
    platform: "javascript",
    level: "error",
    environment: "staging",
    release: "abc123",
    message: PRIVACY_PROBE,
    logentry: { message: PRIVACY_PROBE, params: ["Jana"] },
    transaction: "GET /bookings/a1b2c3d4-0000-4000-8000-123456789abc",
    server_name: "10.1.2.3",
    user: { id: "a1b2c3d4-0000-4000-8000-123456789abc", email: "probe@example.invalid", ip_address: "10.1.2.3" },
    extra: { note: "Jana" },
    modules: { "secret-var-value": "1" },
    tags: { area: "booking", code: "23P01", email: "probe@example.invalid", url: "/x?code=482913" },
    contexts: {
      browser: { name: "Chrome", version: "131", extra: "Jana" },
      os: { name: "Android", version: "15" },
      trace: { trace_id: "t", span_id: "s", data: { q: "482913" } },
      nextjs: { route: "/bookings/a1b2c3d4-0000-4000-8000-123456789abc" },
      state: { form: { phone: "70 123 456" } },
    },
    request: {
      method: "POST",
      url: "https://courtbook-three.vercel.app/bookings/a1b2c3d4-0000-4000-8000-123456789abc?email=probe@example.invalid",
      query_string: "code=482913",
      headers: { cookie: "sb-access-token=xyz", authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" },
      cookies: { "sb-access-token": "xyz" },
      data: { phone: "70 123 456" },
      env: { REMOTE_ADDR: "10.1.2.3" },
    },
    exception: {
      values: [{
        type: "Error",
        value: PRIVACY_PROBE,
        mechanism: { type: "onerror", handled: false, data: { x: "Jana" } },
        stacktrace: {
          frames: [{
            filename: "https://courtbook-three.vercel.app/_next/static/chunks/page.js?token=482913",
            abs_path: "https://courtbook-three.vercel.app/_next/static/chunks/page.js?token=482913",
            function: "reserve", lineno: 10, colno: 5, in_app: true,
            pre_context: ["const pin = 4321"], context_line: "throw new Error(name)", post_context: ["}"],
            vars: { name: "Jana", email: "probe@example.invalid" },
          }],
        },
      }],
    },
    breadcrumbs: [
      { category: "console", message: "Jana probe@example.invalid", timestamp: 1 },
      { category: "ui.click", message: "button#book[aria-label=Jana]", timestamp: 1 },
      { category: "ui.input", message: "input[name=phone]", timestamp: 1 },
      { category: "navigation", data: { from: "/login?email=probe@example.invalid", to: "/bookings/a1b2c3d4-0000-4000-8000-123456789abc" }, timestamp: 2 },
      { category: "fetch", type: "http", data: { method: "POST", url: "https://x.supabase.co/rest/v1/rpc/hold_slot?p=482913", status_code: 500, request_body_size: 10, body: "Jana" }, timestamp: 3 },
    ],
    debug_meta: { images: [{ type: "sourcemap", code_file: "https://courtbook-three.vercel.app/_next/static/chunks/page.js", debug_id: "d1" }] },
  } as unknown as ErrorEvent;
}

describe("scrubEvent: the event is rebuilt from an allowlist", () => {
  const out = scrubEvent(dirtyEvent())!;

  it("leaks none of the fake personal data, anywhere in the event", () => {
    expect(leaks(out)).toEqual([]);
  });
  it("withholds the message and the exception value", () => {
    expect(out.message).toBe(WITHHELD);
    expect(out.logentry).toEqual({ message: WITHHELD });
    expect(out.exception!.values![0].value).toBe(WITHHELD);
    expect(out.exception!.values![0].type).toBe("Error");
  });
  it("keeps file, function, line and column; no source lines, no variables", () => {
    expect(out.exception!.values![0].stacktrace!.frames![0]).toEqual({
      filename: "https://courtbook-three.vercel.app/_next/static/chunks/page.js",
      abs_path: "https://courtbook-three.vercel.app/_next/static/chunks/page.js",
      function: "reserve", module: undefined, lineno: 10, colno: 5, in_app: true,
    });
    expect(out.exception!.values![0].mechanism).toEqual({ type: "onerror", handled: false });
  });
  it("keeps the request's method and normalised path only", () => {
    expect(out.request).toEqual({ method: "POST", url: "https://courtbook-three.vercel.app/bookings/:id" });
    expect(out.transaction).toBe("GET /bookings/:id");
  });
  it("drops user, server name, extra and modules", () => {
    for (const k of ["user", "server_name", "extra", "modules"]) expect(out).not.toHaveProperty(k);
  });
  it("keeps only allowlisted tags and contexts", () => {
    expect(out.tags).toEqual({ area: "booking", code: "23P01" });
    expect(out.contexts).toEqual({
      browser: { name: "Chrome", version: "131" }, os: { name: "Android", version: "15" }, trace: { trace_id: "t", span_id: "s" },
    });
  });
  it("keeps navigation and network breadcrumbs, reduced; drops console, clicks and input", () => {
    expect(out.breadcrumbs).toEqual([
      { category: "navigation", timestamp: 2, data: { from: "/login", to: "/bookings/:id" } },
      { type: "http", category: "fetch", timestamp: 3, level: undefined, data: { method: "POST", url: "https://x.supabase.co/rest/v1/rpc/hold_slot", status_code: 500 } },
    ]);
  });
  it("keeps what is needed to read the error: release, environment, source-map ids", () => {
    expect(out.release).toBe("abc123");
    expect(out.environment).toBe("staging");
    expect(out.debug_meta).toEqual(dirtyEvent().debug_meta);
  });
  it("keeps a fixed message as is", () => {
    const e = { ...dirtyEvent(), message: SAFE_MESSAGES.bookingUnexpected, exception: undefined };
    expect(scrubEvent(e)!.message).toBe("booking: unexpected error");
  });
});

describe("scrubBreadcrumb", () => {
  it("drops everything that is not navigation or network", () => {
    for (const category of ["console", "ui.click", "ui.input", "sentry.event", undefined])
      expect(scrubBreadcrumb({ category, message: "Jana" })).toBeNull();
  });
});

describe("monitoringEnvironment", () => {
  it("names production, staging (m3-dev), other previews and local builds", () => {
    expect(monitoringEnvironment("production", "main")).toBe("production");
    expect(monitoringEnvironment("preview", "m3-dev")).toBe("staging");
    expect(monitoringEnvironment("preview", "w2-monitoring")).toBe("preview");
    expect(monitoringEnvironment(undefined, undefined)).toBe("development");
  });
});

describe("baseOptions", () => {
  it("is off without a DSN, never sends default personal data, never traces", () => {
    const o = baseOptions(undefined, "development");
    expect(o.enabled).toBe(false);
    expect(o.sendDefaultPii).toBe(false);
    expect(o.tracesSampleRate).toBe(0);
    expect(baseOptions("https://k@o1.ingest.sentry.io/1", "staging").enabled).toBe(true);
  });
  it("ignores phone network noise", () => {
    expect(IGNORE_ERRORS).toContain("Failed to fetch");
    expect(IGNORE_ERRORS).toContain("Load failed");
  });
});
