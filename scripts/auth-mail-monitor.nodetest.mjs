// node --test scripts/auth-mail-monitor.nodetest.mjs — no network: fetch is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, CHECK_SQL, PROBE_SQL, MONITOR } from "./auth-mail-monitor.mjs";

const REF = "abcdefghijklmnopqrst";
const TOKEN = "sbp_fc0123456789abcdef0123456789abcdef0123";
const CRON = "https://o0.ingest.sentry.io/api/1/cron/auth-mail/publickey/";
const HC = "https://hc-ping.com/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = () => new Date("2026-11-26T10:17:00Z");
const PERSON = "someone@example.com";

/** A fake fetch: answers the logs API with `api`, records every call; Sentry check-ins answer 202. */
function harness(api, { sentryDown = false, watermark = "2026-11-26T09:12:00.000Z", beatStatus = () => 202, writeFails = false } = {}) {
  const calls = [];
  const lines = [];
  const files = new Map(watermark ? [["/wm", watermark]] : []);
  const fs = { read: (f) => { if (!files.has(f)) throw new Error("ENOENT"); return files.get(f); }, write: (f, t) => { if (writeFails) throw new Error("EACCES"); files.set(f, t); } };
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(CRON) || String(url).startsWith(HC)) {
      if (sentryDown) throw new Error("down");
      const st = beatStatus(String(url));
      return { ok: st >= 200 && st < 300, status: st };
    }
    if (typeof api === "function") return api(url, init);
    return api;
  };
  return { calls, lines, fetch, files, fs, uuid: () => "11111111-2222-4333-8444-555555555555", log: (t) => lines.push(t) };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const env = { SUPABASE_ACCESS_TOKEN: TOKEN, PROJECT_REF: REF, SENTRY_CRONS_URL: CRON, WATERMARK_FILE: "/wm" };
const statuses = (h) => h.calls.filter((c) => c.url.startsWith(CRON)).map((c) => new URL(c.url).searchParams.get("status"));
function nothingSensitive(h) {
  const all = h.lines.join("\n");
  assert.ok(!all.includes("@"), "an email-like string reached the log");
  assert.ok(!all.includes(TOKEN) && !all.includes("sbp_"), "the token reached the log");
  assert.ok(!all.includes("failed for") && !all.includes("denied for") && !all.includes("connect failed"), "raw log or API text reached the log");
}

test("no mail failures: exit 0, counts only, heartbeat in_progress then ok", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 0);
  assert.match(h.lines.join("\n"), /OK: 0 Auth mail failures, 2026-11-26T09:12:00\.000Z to 2026-11-26T10:12:00\.000Z/);
  assert.deepEqual(statuses(h), ["in_progress", "ok"]);
  nothingSensitive(h);
});

test("the request: one GET to the project's logs endpoint, Bearer token, auth_logs counts only, window ≤ 24 h", async () => {
  const h = harness(json(200, { result: [] }));
  await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid });
  const api = h.calls.filter((c) => !c.url.startsWith(CRON));
  assert.equal(api.length, 1);
  const u = new URL(api[0].url);
  assert.equal(u.origin + u.pathname, `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs`);
  assert.equal(api[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(api[0].init.method ?? "GET", "GET");
  assert.equal(u.searchParams.get("sql"), CHECK_SQL);
  assert.ok((Date.parse(u.searchParams.get("iso_timestamp_end")) - Date.parse(u.searchParams.get("iso_timestamp_start"))) <= 24 * 3600_000);
  // the query selects counts grouped by fixed words; it never selects message text, emails or ids
  assert.match(CHECK_SQL, /where source = 'auth_logs'/);
  assert.match(CHECK_SQL, /count\(\) as n/);
  const selected = CHECK_SQL.slice(CHECK_SQL.indexOf("select"), CHECK_SQL.indexOf("from logs"));
  assert.ok(!/\bevent_message\s+as\b|user_id|email|actor|remote_addr|\bid\b/.test(selected), "the select list must not return text, ids or addresses");
});

test("mail failures: exit 1, totals by mailer task and kind, heartbeat error", async () => {
  const h = harness(json(200, { result: [
    { kind: "smtp", task: "mailer.signup", n: 2 },
    { kind: "timeout", task: "mailer.magiclink", n: "1" },
  ] }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 1);
  const out = h.lines.join("\n");
  assert.match(out, /ALERT: 3 Auth mail failure\(s\)/);
  assert.match(out, /mailer\.signup · smtp: 2/);
  assert.match(out, /mailer\.magiclink · timeout: 1/);
  assert.deepEqual(statuses(h), ["in_progress", "error"]);
  nothingSensitive(h);
});

for (const [name, rows] of [
  ["an email address where a task name should be", [{ kind: "smtp", task: PERSON, n: 1 }]],
  ["an extra column carrying the log line", [{ kind: "smtp", task: "mailer.signup", n: 1, event_message: `failed for ${PERSON}` }]],
  ["a kind outside the fixed list", [{ kind: `smtp ${PERSON}`, task: "mailer.signup", n: 1 }]],
  ["a count that is not a whole number", [{ kind: "smtp", task: "mailer.signup", n: "1; drop" }]],
  ["result is not a list", { rows: [PERSON] }],
]) {
  test(`unexpected answer (${name}): exit 2, nothing from it printed, heartbeat error`, async () => {
    const h = harness(json(200, { result: rows }));
    assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
    assert.match(h.lines.join("\n"), /MONITOR FAILURE: the logs API answer did not have the expected shape/);
    assert.deepEqual(statuses(h), ["in_progress", "error"]);
    nothingSensitive(h);
  });
}

for (const [status, hint] of [[401, "token rejected or expired"], [402, "not available on this plan"], [403, "token lacks Logs: Read"], [429, "rate limited"], [500, "API error"]]) {
  test(`HTTP ${status}: exit 2 with the status only (the body is never printed)`, async () => {
    const h = harness({ ok: false, status, json: async () => ({ message: `denied for ${PERSON}` }) });
    assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
    assert.match(h.lines.join("\n"), new RegExp(`HTTP ${status} \\(${hint}`));
    assert.deepEqual(statuses(h), ["in_progress", "error"]);
    nothingSensitive(h);
  });
}

test("query refused inside a 200 (error field with personal text): exit 2, text not printed", async () => {
  const h = harness(json(200, { result: [], error: `syntax error near ${PERSON}` }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.match(h.lines.join("\n"), /MONITOR FAILURE: the logs query was refused\./);
  nothingSensitive(h);
});

test("network failure or timeout: exit 2", async () => {
  const h = harness(async () => { throw new Error(`connect failed ${PERSON}`); });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.match(h.lines.join("\n"), /could not be reached/);
  nothingSensitive(h);
});

test("not JSON: exit 2", async () => {
  const h = harness({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  nothingSensitive(h);
});

for (const [name, e] of [
  ["no token", { ...env, SUPABASE_ACCESS_TOKEN: "" }],
  ["bad project reference", { ...env, PROJECT_REF: "../../v1/organizations" }],
  ["ingestion lag out of range", { ...env, INGEST_LAG_MINUTES: "500" }],
]) {
  test(`misconfigured (${name}): exit 2 without calling the logs API`, async () => {
    const h = harness(json(200, { result: [] }));
    assert.equal(await run({ env: e, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
    assert.equal(h.calls.filter((c) => !c.url.startsWith(CRON)).length, 0);
    assert.deepEqual(statuses(h), ["in_progress", "error"]);
    nothingSensitive(h);
  });
}

test("Sentry unreachable: the run is a monitor failure (exit 2), never reported healthy", async () => {
  const h = harness(json(200, { result: [] }), { sentryDown: true });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.match(h.lines.join("\n"), /heartbeat: could not reach Sentry/);
  assert.deepEqual(statuses(h), ["in_progress", "error"]);
  assert.doesNotMatch(h.lines.join("\n"), /^OK:/m);
});

test("a heartbeat service is required: with neither URL the run fails before reading any log", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env: { ...env, SENTRY_CRONS_URL: "" }, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.equal(h.calls.length, 0);
  assert.match(h.lines.join("\n"), /no heartbeat service is configured/);
});

test("exactly one heartbeat service: both URLs set is a configuration failure, nothing is called", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env: { ...env, HEALTHCHECKS_URL: HC }, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.equal(h.calls.length, 0);
  assert.match(h.lines.join("\n"), /configure exactly one heartbeat service/);
});

const hcEnv = { ...env, SENTRY_CRONS_URL: "", HEALTHCHECKS_URL: HC };
const hcPaths = (h) => h.calls.filter((c) => c.url.startsWith(HC)).map((c) => new URL(c.url).pathname.replace(new URL(HC).pathname, "") || "(success)");

test("Healthchecks.io: a clean check sends /start then success, both GET with the same rid", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env: hcEnv, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 0);
  assert.deepEqual(hcPaths(h), ["/start", "(success)"]);
  const beats = h.calls.filter((c) => c.url.startsWith(HC));
  assert.ok(beats.every((c) => (c.init.method ?? "GET") === "GET" && new URL(c.url).searchParams.get("rid") === "11111111-2222-4333-8444-555555555555"));
});

test("Healthchecks.io: failures found send /start then /fail (exit 1)", async () => {
  const h = harness(json(200, { result: [{ kind: "smtp", task: "mailer.magiclink", n: 2 }] }));
  assert.equal(await run({ env: hcEnv, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 1);
  assert.deepEqual(hcPaths(h), ["/start", "/fail"]);
});

test("Healthchecks.io selftest: /start then /fail, no logs read, exit 2", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env: hcEnv, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid, mode: "selftest" }), 2);
  assert.deepEqual(hcPaths(h), ["/start", "/fail"]);
  assert.equal(h.calls.filter((c) => !c.url.startsWith(HC)).length, 0);
  assert.match(h.lines.join("\n"), /failure alert from Healthchecks\.io/);
});

test("Healthchecks.io unreachable: the run is a monitor failure (exit 2); success is never signalled", async () => {
  const h = harness(json(200, { result: [] }), { sentryDown: true });
  assert.equal(await run({ env: hcEnv, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.match(h.lines.join("\n"), /heartbeat: could not reach/);
  assert.deepEqual(hcPaths(h), ["/start", "/fail"]);
});

// review 25 Nov, finding 2: HTTP 4xx/5xx heartbeat answers
/** answer `code` to the heartbeat whose path ends with `path` ("/start", "/fail", or "" for the success signal), 200 otherwise */
const beatAt = (path, code) => (url) => {
  const p = new URL(url).pathname;
  const hit = path === "" ? !/\/(start|fail)$/.test(p) : p.endsWith(path);
  return hit ? code : 200;
};

test("heartbeat 404 on start (Healthchecks.io, e.g. a wrong ping URL): the check still runs, exit 2, /fail sent, success never sent", async () => {
  const h = harness(json(200, { result: [] }), { beatStatus: beatAt("/start", 404) });
  assert.equal(await run({ env: hcEnv, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.deepEqual(hcPaths(h), ["/start", "/fail"]);
  const all = h.lines.join("\n");
  assert.match(all, /answered HTTP 404 \(status in_progress not recorded\)/);
  assert.match(all, /did not accept this run's start signal/);
  assert.doesNotMatch(all, /^OK:/m);
  assert.equal(h.calls.filter((c) => c.url.startsWith("https://api.supabase.com")).length, 1);
});

test("heartbeat 500 on the success signal (Healthchecks.io): exit 2, the run is not counted healthy", async () => {
  const h = harness(json(200, { result: [] }), { beatStatus: beatAt("", 500) });
  assert.equal(await run({ env: hcEnv, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.deepEqual(hcPaths(h), ["/start", "(success)"]);
  assert.match(h.lines.join("\n"), /did not accept this run's success signal/);
});

test("heartbeat 403 on every signal (Sentry, e.g. a revoked key): exit 2, status ok is never sent", async () => {
  const h = harness(json(200, { result: [] }), { beatStatus: () => 403 });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.deepEqual(statuses(h), ["in_progress", "error"]);
});

test("heartbeat refused while failures were found: still exit 1 (the mail alert), error signalled", async () => {
  const h = harness(json(200, { result: [{ kind: "smtp", task: "mailer.magiclink", n: 1 }] }), { beatStatus: beatAt("/start", 429) });
  assert.equal(await run({ env: hcEnv, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 1);
  assert.deepEqual(hcPaths(h), ["/start", "/fail"]);
});

test("selftest with a refused heartbeat: still exit 2", async () => {
  const h = harness(json(200, { result: [] }), { beatStatus: () => 404 });
  assert.equal(await run({ env: hcEnv, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid, mode: "selftest" }), 2);
});

// review 25 Nov, finding 1: the coverage checkpoint must be saved
test("watermark write fails: monitor failure (exit 2), error signalled, never OK", async () => {
  const h = harness(json(200, { result: [] }), { writeFails: true });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.deepEqual(statuses(h), ["in_progress", "error"]);
  const all = h.lines.join("\n");
  assert.match(all, /coverage checkpoint \(watermark\) could not be saved/);
  assert.doesNotMatch(all, /^OK:/m);
  assert.equal(h.files.get("/wm"), "2026-11-26T09:12:00.000Z", "the old watermark is left as it was");
});

test("watermark write fails while failures were found: exit 1, both reported", async () => {
  const h = harness(json(200, { result: [{ kind: "timeout", task: "mailer.signup", n: 3 }] }), { writeFails: true });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 1);
  const all = h.lines.join("\n");
  assert.match(all, /could not be saved/);
  assert.match(all, /ALERT: 3 Auth mail failure/);
  assert.deepEqual(statuses(h), ["in_progress", "error"]);
});

test("no watermark storage at all in check mode: monitor failure (exit 2), never OK", async () => {
  const h = harness(json(200, { result: [] }));
  // FIRST_RUN so that no coverage gap is reported: the failure must come from the unsaved checkpoint alone
  assert.equal(await run({ env: { ...env, FIRST_RUN: "true" }, fetch: h.fetch, now: NOW, log: h.log, fs: null, uuid: h.uuid }), 2);
  assert.match(h.lines.join("\n"), /could not be saved/);
  assert.doesNotMatch(h.lines.join("\n"), /COVERAGE GAP/);
  assert.deepEqual(statuses(h), ["in_progress", "error"]);
});

test("selftest: a deliberate failure, no logs read; Sentry gets in_progress (with the monitor's schedule) then error", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid, mode: "selftest" }), 2);
  assert.deepEqual(statuses(h), ["in_progress", "error"]);
  assert.equal(h.calls.filter((c) => !c.url.startsWith(CRON)).length, 0);
  const first = h.calls[0];
  assert.equal(first.init.method, "POST");
  assert.deepEqual(JSON.parse(first.init.body), { status: "in_progress", monitor_config: MONITOR });
  assert.deepEqual(MONITOR.schedule, { type: "crontab", value: "17 * * * *" });
  assert.ok(h.calls.every((c) => new URL(c.url).searchParams.get("check_in_id") === "11111111-2222-4333-8444-555555555555"));
  assert.equal(h.files.has("/wm.new"), false);
});

// ---- coverage (review 25 Nov, finding 2) ----
const windowOf = (h) => { const u = new URL(h.calls.find((c) => !c.url.startsWith(CRON)).url); return [u.searchParams.get("iso_timestamp_start"), u.searchParams.get("iso_timestamp_end")]; };

test("a run delayed by hours still covers everything since the previous check (no gap)", async () => {
  const h = harness(json(200, { result: [] }), { watermark: "2026-11-26T06:30:00.000Z" });   // previous check ended 3 h 42 min before
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 0);
  assert.deepEqual(windowOf(h), ["2026-11-26T06:30:00.000Z", "2026-11-26T10:12:00.000Z"]);
  assert.equal(h.files.get("/wm.new"), "2026-11-26T10:12:00.000Z");
});

test("runs at irregular times chain without holes: each window starts where the previous one ended", async () => {
  let wm = "2026-11-26T00:00:00.000Z";
  const ends = [];
  for (const at of ["2026-11-26T00:29:00Z", "2026-11-26T01:16:00Z", "2026-11-26T03:26:00Z", "2026-11-26T03:31:00Z"]) {
    const h = harness(json(200, { result: [] }), { watermark: wm });
    assert.equal(await run({ env, fetch: h.fetch, now: () => new Date(at), log: h.log, fs: h.fs, uuid: h.uuid }), 0);
    const [start, end] = windowOf(h);
    assert.equal(start, wm, "a window must start exactly at the previous end");
    assert.ok(Date.parse(end) >= Date.parse(start));
    ends.push(end);
    wm = h.files.get("/wm.new");
    assert.equal(wm, end);
  }
  assert.deepEqual(ends, ["2026-11-26T00:24:00.000Z", "2026-11-26T01:11:00.000Z", "2026-11-26T03:21:00.000Z", "2026-11-26T03:26:00.000Z"]);
});

test("the previous check ended over 24 h ago: the last 24 h are checked and a COVERAGE GAP is reported (exit 2)", async () => {
  const h = harness(json(200, { result: [] }), { watermark: "2026-11-25T08:00:00.000Z" });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.deepEqual(windowOf(h), ["2026-11-25T10:12:00.000Z", "2026-11-26T10:12:00.000Z"]);
  assert.match(h.lines.join("\n"), /COVERAGE GAP: the previous check ended at 2026-11-25T08:00:00\.000Z/);
  assert.deepEqual(statuses(h), ["in_progress", "error"]);
  assert.equal(h.files.get("/wm.new"), "2026-11-26T10:12:00.000Z");   // the chain restarts from here
});

test("a gap and failures together: exit 1 with both reported", async () => {
  const h = harness(json(200, { result: [{ kind: "smtp", task: "mailer.signup", n: 1 }] }), { watermark: null });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 1);
  const out = h.lines.join("\n");
  assert.match(out, /COVERAGE GAP: no record of where the previous check ended/);
  assert.match(out, /ALERT: 1 Auth mail failure/);
});

test("no watermark: a gap (exit 2) unless the run is marked as the first one", async () => {
  let h = harness(json(200, { result: [] }), { watermark: null });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  h = harness(json(200, { result: [] }), { watermark: null });
  assert.equal(await run({ env: { ...env, FIRST_RUN: "true" }, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 0);
  assert.deepEqual(windowOf(h), ["2026-11-25T10:12:00.000Z", "2026-11-26T10:12:00.000Z"]);
  h = harness(json(200, { result: [] }), { watermark: "not a time" });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
});

test("a failed query never moves the watermark (the next run re-checks the same window)", async () => {
  const h = harness({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
  assert.equal(h.files.has("/wm.new"), false);
});

test("no WATERMARK_FILE configured: monitor failure", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env: { ...env, WATERMARK_FILE: "" }, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid }), 2);
});

test("probe: attribute NAMES only; a value-like key is refused", async () => {
  let h = harness(json(200, { result: [{ key: "action", n: 5 }, { key: "task_type", n: 5 }, { key: "level", n: 9 }] }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid, mode: "probe" }), 0);
  assert.equal(new URL(h.calls[0].url).searchParams.get("sql"), PROBE_SQL);
  assert.match(h.lines.join("\n"), /task_type: 5/);
  assert.equal(statuses(h).length, 0);   // a probe is not a monitoring run
  h = harness(json(200, { result: [{ key: PERSON, n: 1 }] }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, fs: h.fs, uuid: h.uuid, mode: "probe" }), 2);
  nothingSensitive(h);
});
