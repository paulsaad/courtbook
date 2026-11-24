import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import {
  IGNORE_ERRORS, PRIVACY_PROBE, REDACTED, SAFE_MESSAGES, UNMATCHED, WITHHELD, baseOptions, monitoringEnvironment,
  normalizeUrl, routeTemplate, safeFile, safeText, scrubBreadcrumb, scrubEvent,
} from "./monitoring";

/** Every piece of fake personal data these tests use; none may survive scrubbing. */
const SECRETS = ["Jana", "jana", "probe@example.invalid", "70 123 456", "70123456", "482913",
  "a1b2c3d4-0000-4000-8000-123456789abc", "eyJhbGciOiJIUzI1NiJ9.payload.sig", "sb-access-token=xyz", "10.1.2.3",
  "secret-var-value", "const pin = 4321", "tripoli-tennis"];
const leaks = (x: unknown) => SECRETS.filter((s) => JSON.stringify(x).includes(s));

const SITE = "https://courtbook-three.vercel.app";
const SUPA = "https://pwznauyioqykdwodwpvx.supabase.co";
const UUID = "a1b2c3d4-0000-4000-8000-123456789abc";
const DEBUG_ID = "0f4e2d1c-9b8a-4c7d-8e6f-5a4b3c2d1e0f";
const TRACE = "0123456789abcdef0123456789abcdef";
const SPAN = "0123456789abcdef";

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
    for (const m of [PRIVACY_PROBE, "duplicate key value violates unique constraint", "booking: unexpected error x", "", "TypeError: x is undefined"])
      expect(safeText(m)).toBe(WITHHELD);
    for (const m of ["Couldn't load Jana's 482913 bookings now", "Couldn't load your bookings: probe@example.invalid"])
      expect(safeText(m, "LoadError")).toBe(WITHHELD);
    expect(safeText(undefined)).toBe(WITHHELD);
    expect(safeText(42)).toBe(WITHHELD);
  });
});

describe("routeTemplate: our paths are sent only as route templates (review correction 1)", () => {
  it("replaces every dynamic segment, whatever it contains", () => {
    expect(routeTemplate(`/bookings/${UUID}`)).toBe("/bookings/:id");
    expect(routeTemplate("/bookings/jana")).toBe("/bookings/:id");
    expect(routeTemplate("/club/tripoli-tennis/info")).toBe("/club/:slug/info");
    expect(routeTemplate("/club/x")).toBe("/club/:slug");
    expect(routeTemplate("/staff/jana/settings")).toBe("/staff/:slug/settings");
    expect(routeTemplate("/admin/clubs/jana")).toBe("/admin/clubs/:slug");
  });
  it("keeps static routes, preferring them over dynamic ones", () => {
    expect(routeTemplate("/")).toBe("/");
    expect(routeTemplate("/play")).toBe("/play");
    expect(routeTemplate("/admin/monitoring")).toBe("/admin/monitoring");
    expect(routeTemplate("/bookings/")).toBe("/bookings");
    expect(routeTemplate("/club/[slug]")).toBe("/club/:slug");   // Next's own transaction names
  });
  it("sends any path that is not one of our routes as /[unmatched], including short segments", () => {
    for (const p of ["/jana", "/me/jana", "/p/70123456", "/u/482913", `/pay/${UUID}/x`, "/login/probe@example.invalid",
      "/club/tripoli-tennis/jana", "/bookings/a/b", "/t/eyJhbGciOiJIUzI1NiJ9.payload.sig", "/x"])
      expect(routeTemplate(p)).toBe(UNMATCHED);
  });
});

describe("normalizeUrl: any URL made safe", () => {
  it("drops query strings and fragments everywhere", () => {
    expect(normalizeUrl(`${SITE}/auth/callback?code=482913&next=/x#t=1`)).toBe(`${SITE}/auth/callback`);
    expect(normalizeUrl("/login?email=probe@example.invalid")).toBe("/login");
  });
  it("our site: route template, or a hashed build file under /_next/", () => {
    expect(normalizeUrl(`${SITE}/club/tripoli-tennis/info`)).toBe(`${SITE}/club/:slug/info`);
    expect(normalizeUrl(`${SITE}/jana`)).toBe(`${SITE}${UNMATCHED}`);
    expect(normalizeUrl("/_next/static/chunks/0y3k-9a_b.js")).toBe("/_next/static/chunks/0y3k-9a_b.js");
    expect(normalizeUrl("/_next/static/probe@example.invalid.js")).toBe(`/_next/${REDACTED}`);
    expect(normalizeUrl("http://localhost:3000/me")).toBe("http://localhost:3000/me");
  });
  it("Supabase: API and table or function name only", () => {
    expect(normalizeUrl(`${SUPA}/rest/v1/profiles?email=eq.probe@example.invalid`)).toBe(`${SUPA}/rest/v1/profiles`);
    expect(normalizeUrl(`${SUPA}/rest/v1/rpc/hold_slot`)).toBe(`${SUPA}/rest/v1/rpc/hold_slot`);
    expect(normalizeUrl(`${SUPA}/auth/v1/otp`)).toBe(`${SUPA}/auth/v1/otp`);
    expect(normalizeUrl(`${SUPA}/auth/v1/admin/users/${UUID}`)).toBe(`${SUPA}/auth/v1/${REDACTED}`);
    expect(normalizeUrl(`${SUPA}/storage/v1/object/public/club-media/jana.jpg`)).toBe(`${SUPA}/storage/v1/${REDACTED}`);
    expect(normalizeUrl(`${SUPA}/rest/v1/Jana Probe`)).toBe(`${SUPA}/rest/v1/${REDACTED}`);
  });
  it("other sites: a listed host only; an unlisted or spoofed host is redacted whole", () => {
    expect(normalizeUrl("https://fonts.googleapis.com/css2?family=Inter")).toBe(`https://fonts.googleapis.com/${REDACTED}`);
    expect(normalizeUrl("https://jana.example.com/x")).toBe(REDACTED);
    expect(normalizeUrl("https://courtbook-three.vercel.app.jana.example/x")).toBe(REDACTED);
    expect(normalizeUrl("chrome-extension://abc/x.js")).toBe(REDACTED);
    expect(normalizeUrl("//jana.example.com/x")).toBe(REDACTED);
    expect(normalizeUrl("jana")).toBe(REDACTED);
  });
  it("ignores non-strings", () => {
    expect(normalizeUrl(undefined)).toBeUndefined();
    expect(normalizeUrl(5)).toBeUndefined();
  });
});

describe("safeFile: stack-frame files keep what source maps need, nothing else (review correction 2)", () => {
  it("keeps browser build files (as normalised in debug_meta) and server build paths", () => {
    expect(safeFile(`${SITE}/_next/static/chunks/0y3k-9a_b.js?v=482913`)).toBe(`${SITE}/_next/static/chunks/0y3k-9a_b.js`);
    expect(safeFile("/var/task/.next/server/chunks/ssr/node_modules_@sentry_nextjs_1ugx._.js")).toBe("/var/task/.next/server/chunks/ssr/node_modules_@sentry_nextjs_1ugx._.js");
    expect(safeFile("app:///.next/server/app/club/[slug]/page.js")).toBe("app:///.next/server/app/club/[slug]/page.js");
    expect(safeFile("node:internal/process/task_queues")).toBe("node:internal/process/task_queues");
    expect(safeFile("<anonymous>")).toBe("<anonymous>");
  });
  it("keeps build files as @sentry/nextjs renames them (app:///_next/…, as received on staging)", () => {
    expect(safeFile("app:///_next/static/immutable/chunks/1n2d-u5ejz8sl.js")).toBe("app:///_next/static/immutable/chunks/1n2d-u5ejz8sl.js");
    expect(safeFile("app:///_next/server/chunks/ssr/[root-of-the-server]__0ab1._.js")).toBe("app:///_next/server/chunks/ssr/[root-of-the-server]__0ab1._.js");
    expect(safeFile("app:///_next/server/app/api/monitoring/test/route.js?x=482913")).toBe("app:///_next/server/app/api/monitoring/test/route.js");
    for (const f of ["app:///_next/static/probe@example.invalid.js", "app:///_next/static/Jana Probe.js", "app:///Jana/x.js", "app:///_nextjana"])
      expect(safeFile(f)).toBe(REDACTED);
  });
  it("an inline script's page URL becomes its route template; anything odd is redacted", () => {
    expect(safeFile(`${SITE}/bookings/${UUID}?email=probe@example.invalid`)).toBe(`${SITE}/bookings/:id`);
    expect(safeFile("/var/task/probe@example.invalid/x.js")).toBe(REDACTED);
    expect(safeFile("/var/task/Jana Probe/x.js")).toBe(REDACTED);
    expect(safeFile("https://evil.example/jana.js")).toBe(REDACTED);
  });
});

/** An event as the SDKs build it, with everything an SDK or a careless call could attach. */
function dirtyEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1763812800.5,
    platform: "javascript",
    level: "error",
    environment: "staging",
    release: "26d6244abc",
    dist: "jana",
    message: PRIVACY_PROBE,
    logentry: { message: PRIVACY_PROBE, params: ["Jana"] },
    transaction: `GET /bookings/${UUID}`,
    server_name: "10.1.2.3",
    fingerprint: ["{{ default }}", "probe@example.invalid"],
    user: { id: UUID, email: "probe@example.invalid", ip_address: "10.1.2.3" },
    extra: { note: "Jana" },
    modules: { "secret-var-value": "1" },
    sdk: { name: "sentry.javascript.nextjs", version: "11.16.0", integrations: ["Jana"], packages: [{ name: "npm:@sentry/nextjs", version: "11.16.0" }], settings: { infer_ip: "auto" } },
    tags: { area: "booking", code: "23P01", email: "probe@example.invalid", url: "/x?code=482913" },
    contexts: {
      browser: { name: "Chrome", version: "131", extra: "Jana" },
      os: { name: "Android", version: "15" },
      trace: { trace_id: TRACE, span_id: SPAN, data: { q: "482913" } },
      nextjs: { route: `/bookings/${UUID}` },
      state: { form: { phone: "70 123 456" } },
    },
    request: {
      method: "POST",
      url: `${SITE}/bookings/${UUID}?email=probe@example.invalid`,
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
        module: "jana",
        mechanism: { type: "onerror", handled: false, data: { x: "Jana" } },
        stacktrace: {
          frames: [{
            filename: `${SITE}/_next/static/chunks/page.js?token=482913`,
            abs_path: `${SITE}/_next/static/chunks/page.js?token=482913`,
            function: "reserve", module: "jana", lineno: 10, colno: 5, in_app: true,
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
      { category: "navigation", data: { from: "/login?email=probe@example.invalid", to: `/bookings/${UUID}` }, timestamp: 2 },
      { category: "fetch", type: "http", data: { method: "POST", url: `${SUPA}/rest/v1/rpc/hold_slot?p=482913`, status_code: 500, request_body_size: 10, body: "Jana" }, timestamp: 3 },
    ],
    debug_meta: { images: [{ type: "sourcemap", code_file: `${SITE}/_next/static/chunks/page.js?token=482913`, debug_id: DEBUG_ID, extra: "Jana" }] },
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
  it("keeps file, function, line and column; no module, source lines or variables", () => {
    expect(out.exception!.values![0].stacktrace!.frames![0]).toEqual({
      filename: `${SITE}/_next/static/chunks/page.js`,
      abs_path: `${SITE}/_next/static/chunks/page.js`,
      function: "reserve", lineno: 10, colno: 5, in_app: true,
    });
    expect(out.exception!.values![0].mechanism).toEqual({ type: "onerror", handled: false });
  });
  it("keeps the request's method and route template only", () => {
    expect(out.request).toEqual({ method: "POST", url: `${SITE}/bookings/:id` });
    expect(out.transaction).toBe("GET /bookings/:id");
  });
  it("drops server name, extra, modules, fingerprint and dist", () => {
    for (const k of ["server_name", "extra", "modules", "fingerprint", "dist"]) expect(out).not.toHaveProperty(k);
  });
  it("replaces the user with no IP and an empty location, so Sentry adds none (city stored on staging, 22 Nov)", () => {
    expect(out.user).toEqual({ ip_address: null, geo: {} });
    expect(scrubEvent({ ...dirtyEvent(), user: { geo: { city: "Halmstad", country_code: "SE" }, ip_address: "{{auto}}" } } as ErrorEvent)!.user)
      .toEqual({ ip_address: null, geo: {} });
    expect(scrubEvent({ ...dirtyEvent(), user: undefined } as ErrorEvent)!.user).toEqual({ ip_address: null, geo: {} });
  });
  it("keeps only allowlisted tags and contexts", () => {
    expect(out.tags).toEqual({ area: "booking", code: "23P01" });
    expect(out.contexts).toEqual({
      browser: { name: "Chrome", version: "131" }, os: { name: "Android", version: "15" }, trace: { trace_id: TRACE, span_id: SPAN },
    });
  });
  it("keeps navigation and network breadcrumbs, reduced; drops console, clicks and input", () => {
    expect(out.breadcrumbs).toEqual([
      { category: "navigation", timestamp: 2, data: { from: "/login", to: "/bookings/:id" } },
      { type: "http", category: "fetch", timestamp: 3, level: undefined, data: { method: "POST", url: `${SUPA}/rest/v1/rpc/hold_slot`, status_code: 500 } },
    ]);
  });
  it("keeps what is needed to read the error: release, environment, SDK, source-map id matching the frame file", () => {
    expect(out.release).toBe("26d6244abc");
    expect(out.environment).toBe("staging");
    expect(out.sdk).toEqual({ name: "sentry.javascript.nextjs", version: "11.16.0" });
    expect(out.debug_meta).toEqual({ images: [{ type: "sourcemap", code_file: `${SITE}/_next/static/chunks/page.js`, debug_id: DEBUG_ID }] });
    expect(out.debug_meta!.images![0]).toHaveProperty("code_file", out.exception!.values![0].stacktrace!.frames![0].abs_path);
  });
  it("keeps a fixed message as is", () => {
    const e = { ...dirtyEvent(), message: SAFE_MESSAGES.bookingUnexpected, exception: undefined };
    expect(scrubEvent(e)!.message).toBe("booking: unexpected error");
  });
});

describe("scrubEvent: every metadata field has a strict format (review correction 2)", () => {
  /** The dirty event with some fields replaced by values carrying fake data or the wrong shape. */
  const bad = (patch: Record<string, unknown>) => scrubEvent({ ...dirtyEvent(), ...patch } as ErrorEvent)!;
  const frameWith = (f: Record<string, unknown>) =>
    bad({ exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: [{ filename: "/_next/static/chunks/a.js", ...f }] } }] } })
      .exception!.values![0].stacktrace!.frames![0];

  it("function names: JavaScript name formats only, else '?'", () => {
    for (const f of ["reserve", "Object.<anonymous>", "<anonymous>", "async Promise.all", "new LoadError", "Array.prototype.map", "_$x1"])
      expect(frameWith({ function: f }).function).toBe(f);
    for (const f of ["Jana Probe", "async Jana Probe", "new Jana Probe", "Object.Jana Probe", "Jana Probe <probe@example.invalid>",
      "probe@example.invalid", "70 123 456", "+96170123456", "Jana-Probe", "Jana/Probe", "[Jana]", "eval at x (https://courtbook-three.vercel.app/x?code=482913)",
      "Jana Probe: 70 123 456", "async  x", " x", "x ", "x".repeat(200), "a.b.c.d.e.f.g"])
      expect(frameWith({ function: f }).function).toBe("?");
  });
  it("line and column: whole numbers only; in_app: boolean only", () => {
    expect(frameWith({ lineno: "482913", colno: -1, in_app: "Jana" })).toEqual({ filename: "/_next/static/chunks/a.js", abs_path: undefined, function: undefined, lineno: undefined, colno: undefined, in_app: undefined });
  });
  it("exception type and mechanism: fixed shapes", () => {
    const x = bad({ exception: { values: [{ type: "Error: Jana probe@example.invalid", value: "x", mechanism: { type: "Jana 482913", handled: "yes", data: { a: 1 } } }] } }).exception!.values![0];
    expect(x.type).toBe("Error");
    expect(x.mechanism).toEqual({ type: "generic", handled: undefined });
  });
  it("exception types: error class names only", () => {
    const typeOf = (type: string) => bad({ exception: { values: [{ type, value: "x" }] } }).exception!.values![0].type;
    for (const t of ["Error", "TypeError", "LoadError", "ChunkLoadError", "AuthApiError", "DOMException"]) expect(typeOf(t)).toBe(t);
    for (const t of ["Jana", "jana", "Probe482913", "Error Jana", "x".repeat(70) + "Error"]) expect(typeOf(t)).toBe("Error");
  });
  it("release: a commit SHA only", () => {
    expect(bad({ release: "26d6244" }).release).toBe("26d6244");
    for (const r of ["Jana", "test-release", "v1.0.0", "26d6244 jana"]) expect(bad({ release: r }).release).toBeUndefined();
  });
  it("server files: inside the build output, the packages or Node only", () => {
    expect(safeFile("/var/task/Jana/x.js")).toBe(REDACTED);
    expect(safeFile("/home/jana/project/src/x.ts")).toBe(REDACTED);
    expect(safeFile("node:Jana")).toBe(REDACTED);
    expect(safeFile("/var/task/node_modules/next/dist/server/base-server.js")).toBe("/var/task/node_modules/next/dist/server/base-server.js");
  });
  it("debug_meta: an app:///_next/ build file keeps its id, matching the frame file (source maps on staging)", () => {
    const file = "app:///_next/static/immutable/chunks/1n2d-u5ejz8sl.js";
    const o = bad({
      exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: [{ filename: file, abs_path: file, function: "n", lineno: 4, colno: 39388, in_app: true }] } }] },
      debug_meta: { images: [{ type: "sourcemap", code_file: file, debug_id: DEBUG_ID }] },
    });
    expect(o.debug_meta).toEqual({ images: [{ type: "sourcemap", code_file: file, debug_id: DEBUG_ID }] });
    expect(o.exception!.values![0].stacktrace!.frames![0]).toMatchObject({ filename: file, abs_path: file });
  });
  it("debug_meta: only sourcemap images with a debug id and a build file", () => {
    expect(bad({ debug_meta: { images: [{ type: "sourcemap", code_file: "/jana", debug_id: DEBUG_ID }] } }).debug_meta).toBeUndefined();
    expect(bad({ debug_meta: { images: [{ type: "sourcemap", code_file: `${SITE}/club/jana`, debug_id: DEBUG_ID }] } }).debug_meta).toBeUndefined();
    const d = bad({ debug_meta: { images: [
      { type: "sourcemap", code_file: "https://evil.example/jana.js", debug_id: DEBUG_ID },
      { type: "sourcemap", code_file: "/_next/static/chunks/a.js", debug_id: "probe@example.invalid" },
      { type: "macho", code_file: "/_next/static/chunks/a.js", debug_id: DEBUG_ID },
      { type: "sourcemap", code_file: "/_next/static/chunks/a.js", debug_id: DEBUG_ID, code_id: "Jana" },
    ] } }).debug_meta;
    expect(d).toEqual({ images: [{ type: "sourcemap", code_file: "/_next/static/chunks/a.js", debug_id: DEBUG_ID }] });
    expect(bad({ debug_meta: { images: [{ type: "sourcemap", code_file: "https://evil.example/x.js", debug_id: DEBUG_ID }] } }).debug_meta).toBeUndefined();
  });
  it("tags: one shape per tag; anything else drops the tag", () => {
    expect(bad({ tags: { area: "jana", code: "probe@example.invalid", status: "70 123 456", runtime: "Jana" } }).tags).toEqual({});
    expect(bad({ tags: { area: "auth", code: "otp_expired", status: 503, runtime: "node" } }).tags).toEqual({ area: "auth", code: "otp_expired", status: "503", runtime: "node" });
  });
  it("environment, release, SDK, event id, level, platform, timestamp, trace: dropped unless well-formed", () => {
    const o = bad({
      environment: "jana", release: "probe@example.invalid", sdk: { name: "Jana", version: "1" }, event_id: "jana",
      level: "Jana", platform: "Jana Probe", timestamp: "482913", contexts: { trace: { trace_id: "jana", span_id: SPAN }, browser: { name: "probe@example.invalid", version: "131" } },
    });
    for (const k of ["environment", "release", "sdk", "event_id", "level", "platform", "timestamp"]) expect(o[k as keyof ErrorEvent]).toBeUndefined();
    expect(o.contexts).toEqual({});
  });
  it("contexts: known browser, OS and runtime names only; versions version-shaped only", () => {
    const ctx = (contexts: Record<string, unknown>) => bad({ contexts }).contexts;
    expect(ctx({ browser: { name: "Chrome Mobile", version: "131.0.6778.135" }, os: { name: "Android", version: "15" }, runtime: { name: "node", version: "v22.11.0" } }))
      .toEqual({ browser: { name: "Chrome Mobile", version: "131.0.6778.135" }, os: { name: "Android", version: "15" }, runtime: { name: "node", version: "v22.11.0" } });
    expect(ctx({ os: { name: "Amazon Linux", version: "5.10.234-226.919.amzn2.x86_64" } })).toEqual({ os: { name: "Amazon Linux", version: "5.10.234-226.919.amzn2.x86_64" } });
    expect(ctx({
      browser: { name: "Jana Probe", version: "131" },
      os: { name: "Android", version: "Jana 70 123 456" },
      runtime: { name: "probe@example.invalid", version: "482913 Jana" },
    })).toEqual({ os: { name: "Android", version: undefined } });
    for (const version of ["Jana", "probe@example.invalid", "70 123 456", "1.2.3 Jana", "1.2.3-Jana Probe", "+961 70 123 456"])
      expect(ctx({ browser: { name: "Chrome", version } })).toEqual({ browser: { name: "Chrome", version: undefined } });
  });
  it("request method and transaction: known methods only", () => {
    expect(bad({ request: { method: "JANA", url: "/play" }, transaction: "JANA /play" })).toMatchObject({ request: { method: undefined, url: "/play" }, transaction: undefined });
  });
  it("breadcrumb fields: method, status, level and timestamp checked", () => {
    expect(scrubBreadcrumb({ category: "xhr", level: "jana" as never, timestamp: "1" as never, data: { method: "Jana", url: "/play", status_code: "482913" } }))
      .toEqual({ type: "http", category: "xhr", timestamp: undefined, level: undefined, data: { method: undefined, url: "/play", status_code: undefined } });
  });
  it("whatever the input, no fake data survives", () => {
    const o = bad({
      contexts: { browser: { name: "Jana Probe", version: "probe@example.invalid" }, os: { name: "jana", version: "70 123 456" }, runtime: { name: "node", version: "482913 Jana" } },
      environment: "jana", release: "Jana", tags: { area: "jana" }, fingerprint: ["Jana"],
      exception: { values: [{ type: "Jana", value: "Jana", mechanism: { type: "Jana" }, stacktrace: { frames: [{ filename: "/var/task/Jana/x.js", abs_path: "https://evil.example/jana", function: "probe@example.invalid", module: "jana" }] } }] },
      debug_meta: { images: [{ type: "sourcemap", code_file: "/jana", debug_id: DEBUG_ID }] },
    });
    expect(leaks(o)).toEqual([]);
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
    expect(monitoringEnvironment("preview", "staging-web")).toBe("staging");
    expect(monitoringEnvironment("preview", "staging-web-x")).toBe("preview");
    expect(monitoringEnvironment("production", "staging-web")).toBe("production");
    expect(monitoringEnvironment("preview", "w2-monitoring")).toBe("preview");
    expect(monitoringEnvironment(undefined, undefined)).toBe("development");
  });
});

describe("baseOptions", () => {
  it("is off without a DSN, collects nothing on its own, never traces", () => {
    const o = baseOptions(undefined, "development");
    expect(o.enabled).toBe(false);
    expect(o).not.toHaveProperty("sendDefaultPii");   // removed in SDK 11; dataCollection replaces it
    expect(o.dataCollection).toEqual({
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, mcp: { inputs: false, outputs: false },
      databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0,
    });
    expect(o.tracesSampleRate).toBe(0);
    expect(baseOptions("https://k@o1.ingest.sentry.io/1", "staging").enabled).toBe(true);
  });
  it("ignores phone network noise", () => {
    expect(IGNORE_ERRORS).toContain("Failed to fetch");
    expect(IGNORE_ERRORS).toContain("Load failed");
  });
});
