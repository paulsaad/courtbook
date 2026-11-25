// node --test scripts/auth-mail-monitor.nodetest.mjs — no network: fetch is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, CHECK_SQL, PROBE_SQL } from "./auth-mail-monitor.mjs";

const REF = "abcdefghijklmnopqrst";
const TOKEN = "sbp_fc0123456789abcdef0123456789abcdef0123";
const CRON = "https://o0.ingest.sentry.io/api/1/cron/auth-mail/publickey/";
const NOW = () => new Date("2026-11-26T10:17:00Z");
const PERSON = "someone@example.com";

/** A fake fetch: answers the logs API with `api`, records every call; Sentry check-ins answer 202. */
function harness(api, { sentryDown = false } = {}) {
  const calls = [];
  const lines = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith(CRON)) { if (sentryDown) throw new Error("down"); return { ok: true, status: 202 }; }
    if (typeof api === "function") return api(url, init);
    return api;
  };
  return { calls, lines, fetch, log: (t) => lines.push(t) };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const env = { SUPABASE_ACCESS_TOKEN: TOKEN, PROJECT_REF: REF, SENTRY_CRONS_URL: CRON };
const statuses = (h) => h.calls.filter((c) => c.url.startsWith(CRON)).map((c) => new URL(c.url).searchParams.get("status"));
function nothingSensitive(h) {
  const all = h.lines.join("\n");
  assert.ok(!all.includes("@"), "an email-like string reached the log");
  assert.ok(!all.includes(TOKEN) && !all.includes("sbp_"), "the token reached the log");
  assert.ok(!all.includes("failed for") && !all.includes("denied for") && !all.includes("connect failed"), "raw log or API text reached the log");
}

test("no mail failures: exit 0, counts only, heartbeat in_progress then ok", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log }), 0);
  assert.match(h.lines.join("\n"), /OK: 0 Auth mail failures, 2026-11-26T09:07:00\.000Z to 2026-11-26T10:17:00\.000Z/);
  assert.deepEqual(statuses(h), ["in_progress", "ok"]);
  nothingSensitive(h);
});

test("the request: one GET to the project's logs endpoint, Bearer token, auth_logs counts only, window ≤ 24 h", async () => {
  const h = harness(json(200, { result: [] }));
  await run({ env, fetch: h.fetch, now: NOW, log: h.log });
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
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log }), 1);
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
    assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log }), 2);
    assert.match(h.lines.join("\n"), /MONITOR FAILURE: the logs API answer did not have the expected shape/);
    assert.deepEqual(statuses(h), ["in_progress", "error"]);
    nothingSensitive(h);
  });
}

for (const [status, hint] of [[401, "token rejected or expired"], [402, "not available on this plan"], [403, "token lacks Logs: Read"], [429, "rate limited"], [500, "API error"]]) {
  test(`HTTP ${status}: exit 2 with the status only (the body is never printed)`, async () => {
    const h = harness({ ok: false, status, json: async () => ({ message: `denied for ${PERSON}` }) });
    assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log }), 2);
    assert.match(h.lines.join("\n"), new RegExp(`HTTP ${status} \\(${hint}`));
    assert.deepEqual(statuses(h), ["in_progress", "error"]);
    nothingSensitive(h);
  });
}

test("query refused inside a 200 (error field with personal text): exit 2, text not printed", async () => {
  const h = harness(json(200, { result: [], error: `syntax error near ${PERSON}` }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log }), 2);
  assert.match(h.lines.join("\n"), /MONITOR FAILURE: the logs query was refused\./);
  nothingSensitive(h);
});

test("network failure or timeout: exit 2", async () => {
  const h = harness(async () => { throw new Error(`connect failed ${PERSON}`); });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log }), 2);
  assert.match(h.lines.join("\n"), /could not be reached/);
  nothingSensitive(h);
});

test("not JSON: exit 2", async () => {
  const h = harness({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log }), 2);
  nothingSensitive(h);
});

for (const [name, e] of [
  ["no token", { ...env, SUPABASE_ACCESS_TOKEN: "" }],
  ["bad project reference", { ...env, PROJECT_REF: "../../v1/organizations" }],
  ["window over 24 h", { ...env, WINDOW_MINUTES: "2000" }],
]) {
  test(`misconfigured (${name}): exit 2 without calling the logs API`, async () => {
    const h = harness(json(200, { result: [] }));
    assert.equal(await run({ env: e, fetch: h.fetch, now: NOW, log: h.log }), 2);
    assert.equal(h.calls.filter((c) => !c.url.startsWith(CRON)).length, 0);
    assert.deepEqual(statuses(h), ["in_progress", "error"]);
    nothingSensitive(h);
  });
}

test("Sentry unreachable: the result still stands (exit 0), a note is logged; Sentry would then report a missed run", async () => {
  const h = harness(json(200, { result: [] }), { sentryDown: true });
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log }), 0);
  assert.match(h.lines.join("\n"), /heartbeat: could not reach Sentry/);
});

test("no Sentry URL configured: no heartbeat calls, same result", async () => {
  const h = harness(json(200, { result: [] }));
  assert.equal(await run({ env: { ...env, SENTRY_CRONS_URL: "" }, fetch: h.fetch, now: NOW, log: h.log }), 0);
  assert.equal(statuses(h).length, 0);
});

test("probe: attribute NAMES only; a value-like key is refused", async () => {
  let h = harness(json(200, { result: [{ key: "action", n: 5 }, { key: "task_type", n: 5 }, { key: "level", n: 9 }] }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, mode: "probe" }), 0);
  assert.equal(new URL(h.calls[0].url).searchParams.get("sql"), PROBE_SQL);
  assert.match(h.lines.join("\n"), /task_type: 5/);
  assert.equal(statuses(h).length, 0);   // a probe is not a monitoring run
  h = harness(json(200, { result: [{ key: PERSON, n: 1 }] }));
  assert.equal(await run({ env, fetch: h.fetch, now: NOW, log: h.log, mode: "probe" }), 2);
  nothingSensitive(h);
});
