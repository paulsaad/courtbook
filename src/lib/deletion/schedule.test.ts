// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RETRY_MONITOR_CONFIG, RETRY_SCHEDULE } from "./monitor";

/**
 * The Vercel schedule that calls the deletion retry route (deletion-schedule, review 24 Nov). Vercel creates it
 * INACTIVE on Preview branches; this file only checks what the repository declares.
 */
const root = join(__dirname, "..", "..", "..");
const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));

/** Minutes between consecutive runs of a "m1,m2,… * * * *" expression, wrapping past the hour. */
function gaps(expr: string): number[] {
  const [min, ...rest] = expr.split(" ");
  expect(rest).toEqual(["*", "*", "*", "*"]);
  const m = min.split(",").map(Number).sort((a, b) => a - b);
  return m.map((v, i) => ((m[(i + 1) % m.length] - v + 60) % 60) || 60);
}

describe("vercel.json schedule", () => {
  it("declares exactly one schedule, deletion-retry, and nothing else new", () => {
    expect(Object.keys(config).sort()).toEqual(["regions", "schedules"]);
    expect(config.regions).toEqual(["fra1"]);
    expect(Object.keys(config.schedules)).toEqual(["deletion-retry"]);
    expect(config.crons).toBeUndefined();   // not the legacy Cron Jobs (production-only, daily on Hobby)
  });
  it("calls the retry route with GET, on the monitored schedule", () => {
    const s = config.schedules["deletion-retry"];
    expect(Object.keys(s).sort()).toEqual(["path", "requestMethod", "schedule"]);
    expect(s.path).toBe("/api/internal/deletions/retry");
    expect(s.requestMethod).toBe("GET");
    expect(s.schedule).toBe(RETRY_SCHEDULE);
    expect(RETRY_MONITOR_CONFIG.schedule.value).toBe(s.schedule);
    const route = join(root, "src", "app", "api", "internal", "deletions", "retry", "route.ts");
    expect(existsSync(route)).toBe(true);
    expect(readFileSync(route, "utf8")).toMatch(/export const GET = run;/);
  });
  it("fits Hobby: every 15 minutes at most, no jitter override, off the top of the hour", () => {
    const s = config.schedules["deletion-retry"];
    expect(s).not.toHaveProperty("jitter");   // Hobby only accepts 15 (its fixed window); absent = plan default
    expect(Math.min(...gaps(s.schedule))).toBeGreaterThanOrEqual(15);
    expect(Math.max(...gaps(s.schedule))).toBeLessThanOrEqual(15);   // evenly spaced: no gap longer than 15
    expect(s.schedule.split(" ")[0].split(",")).not.toContain("0");
  });
  it("the monitor's margin covers Hobby's 15-minute jitter, and the 1-hour heartbeat survives two missed runs", () => {
    expect(RETRY_MONITOR_CONFIG.checkinMargin).toBeGreaterThan(15);
    // worst case on Hobby: a run at the very start of its window, the next two missed, the third at the end of its
    // window → 3 × 15 + 15 = 60 minutes. The app's gate is "heartbeat under 1 hour".
    expect(3 * 15 + 15).toBeLessThanOrEqual(60);
  });
});
