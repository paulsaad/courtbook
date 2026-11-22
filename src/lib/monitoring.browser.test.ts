// @vitest-environment jsdom
/**
 * The real browser SDK (what @sentry/nextjs runs in the browser), the real options and a recording transport:
 * an uncaught error from a page full of personal data, after clicks, typing and console output, must reach the
 * wire with none of it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/browser";
import { createTransport, type BaseTransportOptions } from "@sentry/core";
import { PRIVACY_PROBE, SAFE_MESSAGES, WITHHELD, baseOptions } from "./monitoring";

const SECRETS = ["Jana", "probe@example.invalid", "70 123 456", "482913", "a1b2c3d4-0000-4000-8000-123456789abc"];
const wire: string[] = [];

beforeAll(() => {
  window.history.replaceState(null, "", "/bookings/a1b2c3d4-0000-4000-8000-123456789abc?email=probe@example.invalid#482913");
  Sentry.init({
    ...baseOptions("https://publickey@o1.ingest.sentry.io/1", "test"),
    transport: (o: BaseTransportOptions) => createTransport(o, async (req) => {
      wire.push(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body));
      return { statusCode: 200 };
    }),
  });
});
afterAll(async () => { await Sentry.close(); });

const events = () => wire.flatMap((b) => b.split("\n").filter(Boolean).map((l) => JSON.parse(l)))
  .filter((x) => x && typeof x === "object" && ("exception" in x || "message" in x));

describe("what actually leaves the browser", () => {
  it("leaks nothing from the page, the URL, the console or the form", { timeout: 20000 }, async () => {
    document.body.innerHTML = `<form><input name="phone" value="70 123 456"><button type="button" id="b" aria-label="Book for Jana">Jana</button></form>`;
    (document.getElementById("b") as HTMLButtonElement).click();
    console.log("signed in as probe@example.invalid, code 482913");
    Sentry.captureException(new Error(PRIVACY_PROBE));
    Sentry.captureException(new Error(SAFE_MESSAGES.testBrowser));
    expect(await Sentry.flush(10000)).toBe(true);

    const all = wire.join("\n");
    expect(SECRETS.filter((s) => all.includes(s))).toEqual([]);
    expect(all).not.toContain('"did"');
    expect(all).not.toContain("{{auto}}");
    // Sentry must not infer the sender's IP (and from it a city): found on the staging events, 22 Nov
    expect(all).toContain('"infer_ip":"never"');
    expect(all).not.toContain('"infer_ip":"auto"');
    for (const e of events()) expect(e.user).toEqual({ ip_address: null, geo: {} });

    const [probe, fixed] = events();
    expect(probe.exception.values[0].value).toBe(WITHHELD);
    expect(fixed.exception.values[0].value).toBe("CourtBook monitoring test (browser)");
    expect(probe.request).toEqual({ url: "http://localhost:3000/bookings/:id" });
    expect((probe.breadcrumbs ?? []).every((b: { category: string }) => ["navigation", "fetch", "xhr"].includes(b.category))).toBe(true);
  });

  it("source maps still match: the SDK's debug id lands on the same file name the frames carry", { timeout: 20000 }, async () => {
    const from = wire.length;
    const file = "https://courtbook-three.vercel.app/_next/static/chunks/0abc-1def.js";
    const debugId = "0f4e2d1c-9b8a-4c7d-8e6f-5a4b3c2d1e0f";
    // what the build injects into each chunk: a stack string pointing at the chunk, mapped to its debug id
    (globalThis as { _sentryDebugIds?: Record<string, string> })._sentryDebugIds = { [`Error\n    at x (${file}:1:1)`]: debugId };
    Sentry.captureEvent({
      exception: { values: [{ type: "TypeError", value: "Jana Probe", stacktrace: { frames: [
        { filename: file, abs_path: file, function: "Jana Probe", lineno: 1, colno: 99, in_app: true },
        { filename: file, abs_path: file, function: "reserve", lineno: 1, colno: 120, in_app: true },
      ] } }] },
    });
    expect(await Sentry.flush(10000)).toBe(true);
    const sent = wire.slice(from).join("\n");
    expect(SECRETS.filter((x) => sent.includes(x))).toEqual([]);
    const event = sent.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((x) => x && x.exception);
    const frames = event.exception.values[0].stacktrace.frames;
    expect(frames.map((f: { function: string }) => f.function)).toEqual(["?", "reserve"]);
    expect(event.debug_meta).toEqual({ images: [{ type: "sourcemap", code_file: file, debug_id: debugId }] });
    expect(frames.every((f: { abs_path: string }) => f.abs_path === event.debug_meta.images[0].code_file)).toBe(true);
  });
});
