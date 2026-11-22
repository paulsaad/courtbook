// @vitest-environment node
/**
 * The real server SDK, the real options (baseOptions) and a transport that records what would be sent to Sentry:
 * the bytes on the wire must contain none of the fake personal data, whatever the code attaches.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { createTransport, type BaseTransportOptions } from "@sentry/core";
import { PRIVACY_PROBE, WITHHELD, baseOptions } from "./monitoring";
import { explainBookingError, report, reportAuthError, reportsSettled } from "./report";

const SECRETS = ["Jana", "probe@example.invalid", "70 123 456", "482913", "a1b2c3d4-0000-4000-8000-123456789abc", "sb-access-token"];
const wire: string[] = [];

beforeAll(() => {
  Sentry.init({
    ...baseOptions("https://publickey@o1.ingest.sentry.io/1", "test"),
    release: "test-release",
    transport: (o: BaseTransportOptions) => createTransport(o, async (req) => {
      wire.push(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body));
      return { statusCode: 200 };
    }),
  });
});
afterAll(async () => { await Sentry.close(); });

/** The JSON items of everything sent so far (an envelope is newline-separated JSON). */
function sentEvents(): Record<string, unknown>[] {
  return wire.flatMap((b) => b.split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((x) => typeof x === "object" && x && ("exception" in x || "message" in x));
}

describe("what actually leaves the server", () => {
  it("sends our fixed messages with codes, withholds everything else, leaks nothing", { timeout: 20000 }, async () => {
    Sentry.setUser({ id: "a1b2c3d4-0000-4000-8000-123456789abc", email: "probe@example.invalid", ip_address: "{{auto}}" });
    Sentry.setExtra("form", { name: "Jana", phone: "70 123 456" });
    Sentry.setTag("email", "probe@example.invalid");
    Sentry.addBreadcrumb({ category: "console", message: "signed in probe@example.invalid with 482913" });
    Sentry.addBreadcrumb({ category: "fetch", type: "http", data: { method: "GET", url: "https://x.supabase.co/rest/v1/profiles?email=eq.probe@example.invalid", status_code: 500 } });

    await report("bookingUnexpected", "booking", { code: "23P01" });
    expect(explainBookingError("permission denied for Jana (probe@example.invalid)", "42501")).toBe("Something went wrong. Refresh and try again.");
    expect(explainBookingError("slot_taken", "P0001")).not.toBe("Something went wrong. Refresh and try again.");   // expected refusal: not reported
    await reportAuthError("authCodeSend", { status: 500, code: "unexpected_failure" });
    await reportAuthError("authCodeCheck", { status: 403, code: "otp_expired" });                                   // the person's own mistake: not reported
    Sentry.captureException(new Error(PRIVACY_PROBE, { cause: new Error("db said: Jana 70 123 456") }));
    await reportsSettled();   // the booking report is sent once the SDK import resolves
    expect(await Sentry.flush(10000)).toBe(true);

    const all = wire.join("\n");
    expect(SECRETS.filter((s) => all.includes(s))).toEqual([]);
    expect(all).not.toContain('"did"');          // no release-health session (it carries a user id)
    expect(all).not.toContain("{{auto}}");       // and never asks Sentry to store the IP address

    const events = sentEvents();
    const reports = events.filter((e) => e.message).map((e) => `${e.message} | ${(e.tags as Record<string, string>).code}`).sort();
    expect(reports).toEqual([
      "auth: sign-in code could not be sent | unexpected_failure",
      "booking: unexpected error | 23P01",
      "booking: unexpected error | 42501",
    ]);

    expect(events).toHaveLength(4);
    const ex = events.find((e) => !e.message)!.exception as { values: { type: string; value: string }[] };
    expect(ex.values.map((v) => v.value)).toEqual([WITHHELD, WITHHELD]);   // the error and its cause
    for (const e of events) {
      expect(e.user).toEqual({ ip_address: null, geo: {} });   // nothing for Sentry to fill in
      expect(e).not.toHaveProperty("extra");
      expect(e).not.toHaveProperty("server_name");
      expect(Object.keys(e.tags as object).every((k) => ["area", "code", "status", "runtime"].includes(k))).toBe(true);
    }
  });

  it("hostile function names and contexts set on the scope do not reach the wire", { timeout: 20000 }, async () => {
    const from = wire.length;
    Sentry.setContext("browser", { name: "Jana Probe", version: "probe@example.invalid" });
    Sentry.setContext("os", { name: "Android", version: "70 123 456" });
    Sentry.setContext("runtime", { name: "probe@example.invalid", version: "482913" });
    Sentry.captureEvent({
      exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: [
        { filename: "/var/task/.next/server/chunks/ssr/app.js", function: "Jana Probe", lineno: 1, colno: 1, in_app: true },
        { filename: "/var/task/.next/server/chunks/ssr/app.js", function: "async probe@example.invalid", lineno: 2, colno: 1, in_app: true },
        { filename: "/var/task/.next/server/chunks/ssr/app.js", function: "Object.reserve", lineno: 3, colno: 1, in_app: true },
      ] } }] },
    });
    expect(await Sentry.flush(10000)).toBe(true);
    const sent = wire.slice(from).join("\n");
    expect(SECRETS.filter((x) => sent.includes(x))).toEqual([]);
    const event = sent.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x && x.exception);
    expect(event.exception.values[0].stacktrace.frames.map((f: { function: string }) => f.function)).toEqual(["?", "?", "Object.reserve"]);
    expect(event.contexts.browser).toBeUndefined();
    // the server SDK replaces the runtime context with its own; only a known name and a version-shaped value remain
    if (event.contexts.runtime) expect(event.contexts.runtime).toEqual({ name: "node", version: expect.stringMatching(/^v\d+\.\d+\.\d+$/) });
    expect(event.contexts.os).toEqual({ name: "Android" });
  });
});
