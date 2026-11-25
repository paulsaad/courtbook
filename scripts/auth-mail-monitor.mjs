#!/usr/bin/env node
/**
 * Auth mail monitor (B5). Asks Supabase for the number of Auth sign-in-mail failures in the last window, and says so.
 *
 * Why: Supabase Auth can answer 200 to a code request and then fail to send the email in the background; the failure
 * only appears in the Auth logs (an error with action "apitask", task "mailer.<type>"). Nobody sees it otherwise.
 *
 * What it reads: one ClickHouse query on the project's logs (Management API, GET /v1/projects/{ref}/analytics/
 * endpoints/logs) that returns COUNTS ONLY, grouped by a fixed failure kind and the mailer task name. No log line, no
 * message text, no email address and no user id is ever requested, and the answer is checked before anything is
 * printed: a row with any other column, or a value outside the fixed vocabulary, is treated as a monitor failure and
 * not shown. The repository is public, so the run log is public: it must only ever contain counts and fixed words.
 *
 * Token: a scoped personal access token limited to ONE project and the "Logs: Read" permission (env
 * SUPABASE_ACCESS_TOKEN). Never printed.
 *
 * Exit codes: 0 = checked, no mail failures; 1 = mail failures found (alert); 2 = the monitor could not check, or the
 * checked windows have a gap (alert).
 *
 * Coverage (review 25 Nov, finding 2): each run checks from where the previous successful run stopped (a watermark
 * kept between runs, WATERMARK_FILE) up to now minus an ingestion lag (INGEST_LAG_MINUTES, default 5), so windows
 * chain without holes however late GitHub starts a run. The API allows at most 24 hours per query: if the previous
 * successful check ended more than 24 hours ago, or the watermark is missing (other than on a first run the person
 * marks as such, FIRST_RUN=true), the last 24 hours are still checked and the run also reports a COVERAGE GAP (exit 2).
 * The new watermark is written (to WATERMARK_FILE + ".new") only after a successful query.
 *
 * Heartbeat (review 25 Nov, finding 1): a heartbeat service is REQUIRED for check runs: Sentry Crons (SENTRY_CRONS_URL)
 * or Healthchecks.io (HEALTHCHECKS_URL), exactly one; without one the run fails. A start signal, then success on exit
 * 0 or failure on 1 or 2, all with one run id. A run that never happens is reported by the service as missed; a failed
 * run is reported as failed and also fails the GitHub run. A heartbeat the service does not accept (no answer, or HTTP
 * 4xx/5xx) makes the run a monitor failure (exit 2), and success is never signalled after it (review 25 Nov).
 *
 * Modes: `check` (default) as above; `probe` lists the attribute KEYS present on Auth log events in the window (names
 * only, never values); `selftest` makes a deliberate failure (no logs read): Sentry error check-in, exit 2, so that
 * the alert paths can be proved end to end before activation.
 */

export const KINDS = ["smtp", "timeout", "rate_limit", "address_validation", "other"];
const TASK = /^mailer\.[a-z_]{1,40}$/;
const KEY = /^[a-z0-9_.]{1,60}$/;
const REF = /^[a-z]{20}$/;
const SAFE_CODE = /^[A-Za-z0-9_ -]{1,40}$/;

export const CHECK_SQL = `
select
  multiIf(
    positionCaseInsensitive(event_message, 'smtp') > 0, 'smtp',
    positionCaseInsensitive(event_message, 'timeout') > 0 or positionCaseInsensitive(event_message, 'deadline') > 0, 'timeout',
    positionCaseInsensitive(event_message, 'rate limit') > 0, 'rate_limit',
    positionCaseInsensitive(event_message, 'validat') > 0, 'address_validation',
    'other') as kind,
  if(match(log_attributes['task_type'], '^mailer\\\\.[a-z_]{1,40}$'), log_attributes['task_type'], 'mailer.unknown') as task,
  count() as n
from logs
where source = 'auth_logs'
  and (log_attributes['action'] = 'apitask' or positionCaseInsensitive(event_message, 'apitask') > 0)
  and (log_attributes['task_type'] like 'mailer.%' or positionCaseInsensitive(event_message, 'mailer') > 0)
  and (lower(log_attributes['level']) = 'error' or positionCaseInsensitive(event_message, 'error') > 0)
group by kind, task
order by kind, task
`.trim();

export const PROBE_SQL = `
select arrayJoin(mapKeys(log_attributes)) as key, count() as n
from logs
where source = 'auth_logs'
group by key
order by key
limit 200
`.trim();

/** Fail closed: anything that is not exactly what we asked for is a monitor failure, never printed. */
function checkRows(rows, mode) {
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const keys = Object.keys(r).sort().join(",");
    const n = Number(r.n);
    if (!Number.isInteger(n) || n < 0) return null;
    if (mode === "probe") {
      if (keys !== "key,n" || typeof r.key !== "string" || !KEY.test(r.key)) return null;
      out.push({ key: r.key, n });
    } else {
      if (keys !== "kind,n,task" || !KINDS.includes(r.kind) || typeof r.task !== "string" || !(TASK.test(r.task))) return null;
      out.push({ kind: r.kind, task: r.task, n });
    }
  }
  return out;
}

/** The last line of defence before anything reaches the (public) log. */
function safe(text) {
  return /@|sbp_|eyJ|[A-Za-z0-9_-]{41,}/.test(text) ? "(output withheld: it did not match the expected safe shape)" : text;
}

export const MONITOR = { schedule: { type: "crontab", value: "17 * * * *" }, checkin_margin: 30, max_runtime: 10, timezone: "UTC" };

/**
 * One heartbeat per status, to the one configured service:
 *  - Sentry Crons (SENTRY_CRONS_URL): ?check_in_id=<uuid>&status=in_progress|ok|error; in_progress is a POST that also
 *    states the monitor's schedule (MONITOR);
 *  - Healthchecks.io (HEALTHCHECKS_URL, the check's ping URL): /start, success, /fail, each with ?rid=<uuid>; the
 *    schedule (cron "17 * * * *", UTC, grace 30 minutes) is set on the check itself.
 */
const name = (hb) => (hb.kind === "sentry" ? "Sentry" : "Healthchecks.io");
/** Returns true only when the service accepted the signal (HTTP 2xx). */
async function heartbeat(fetchImpl, hb, checkInId, status, log) {
  if (!hb) return false;
  try {
    let u, init = { method: "GET" };
    if (hb.kind === "sentry") {
      u = new URL(hb.url);
      u.searchParams.set("check_in_id", checkInId);
      u.searchParams.set("status", status);
      if (status === "in_progress") init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, monitor_config: MONITOR }) };
    } else {
      u = new URL(hb.url.replace(/\/+$/, "") + ({ in_progress: "/start", ok: "", error: "/fail" }[status]));
      u.searchParams.set("rid", checkInId);
    }
    const r = await fetchImpl(u.toString(), { ...init, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) { log(`heartbeat: ${name(hb)} answered HTTP ${r.status} (status ${status} not recorded)`); return false; }
    return true;
  } catch {
    log(`heartbeat: could not reach ${name(hb)} (status ${status} not recorded)`);
    return false;
  }
}

const iso = (d) => d.toISOString();

export async function run({ env, fetch: fetchImpl = fetch, now = () => new Date(), log = console.log, mode = "check", fs = null, uuid = () => crypto.randomUUID() }) {
  const token = env.SUPABASE_ACCESS_TOKEN ?? "";
  const ref = env.PROJECT_REF ?? "";
  const lag = Number(env.INGEST_LAG_MINUTES ?? 5);
  const sentryUrl = env.SENTRY_CRONS_URL || "";
  const hcUrl = env.HEALTHCHECKS_URL || "";
  const hb = sentryUrl && !hcUrl ? { kind: "sentry", url: sentryUrl } : hcUrl && !sentryUrl ? { kind: "healthchecks", url: hcUrl } : null;
  const wmFile = env.WATERMARK_FILE || "";
  const firstRun = env.FIRST_RUN === "true";
  const say = (t) => log(safe(t));
  const checkInId = uuid();
  // review 25 Nov (finding 2): a heartbeat the service did not accept means the run is not confirmed healthy
  let heartbeatRefused = false;
  const beat = async (status) => {
    if (mode !== "check" && mode !== "selftest") return true;
    const accepted = await heartbeat(fetchImpl, hb, checkInId, status, say);
    if (!accepted) heartbeatRefused = true;
    return accepted;
  };
  const fail = async (why) => {
    say(`MONITOR FAILURE: ${why}. Mail failures could not be checked.`);
    await beat("error");
    return 2;
  };

  if (mode !== "probe" && !hb) {
    say(sentryUrl && hcUrl
      ? "MONITOR FAILURE: both SENTRY_CRONS_URL and HEALTHCHECKS_URL are set; configure exactly one heartbeat service."
      : "MONITOR FAILURE: no heartbeat service is configured (SENTRY_CRONS_URL or HEALTHCHECKS_URL); one is required, so that runs that fail or never happen are reported.");
    return 2;
  }
  await beat("in_progress");
  if (mode === "selftest") {
    say(`SELFTEST: a deliberate monitor failure (no logs were read). Expect a failed-run notice from GitHub and a failure alert from ${name(hb)}.`);
    await beat("error");
    return 2;
  }
  if (!token) return fail("no logs token (SUPABASE_ACCESS_TOKEN) is configured");
  if (!REF.test(ref)) return fail("PROJECT_REF is missing or not a project reference");
  if (!Number.isInteger(lag) || lag < 0 || lag > 60) return fail("INGEST_LAG_MINUTES must be 0 to 60");
  if (mode === "check" && !wmFile) return fail("no WATERMARK_FILE is configured (coverage between runs cannot be guaranteed)");

  // the window: from the previous successful check's end (or 24 h back), to now minus the ingestion lag
  const end = new Date(now().getTime() - lag * 60_000);
  const max = 24 * 3600_000;
  let start = new Date(end.getTime() - max);
  let gap = null;
  if (mode === "check") {
    let wm = null;
    try { wm = fs ? fs.read(wmFile) : null; } catch { wm = null; }
    const t = wm && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(wm.trim()) ? Date.parse(wm.trim()) : NaN;
    if (Number.isNaN(t)) {
      if (!firstRun) gap = "no record of where the previous check ended (watermark missing); the last 24 hours were checked, anything earlier is unknown";
    } else if (end.getTime() - t > max) {
      gap = `the previous check ended at ${iso(new Date(t))}, more than 24 hours ago; the last 24 hours were checked, the hours before are not covered`;
    } else {
      start = new Date(Math.min(t, end.getTime()));
    }
  } else {
    start = new Date(end.getTime() - 70 * 60_000);   // probe: a short recent window is enough
  }

  const url = new URL(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs`);
  url.searchParams.set("sql", mode === "probe" ? PROBE_SQL : CHECK_SQL);
  url.searchParams.set("iso_timestamp_start", iso(start));
  url.searchParams.set("iso_timestamp_end", iso(end));

  let res;
  try {
    res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch {
    return fail("the Supabase logs API could not be reached (network error or timeout)");
  }
  if (!res.ok) {
    const hint = { 401: "token rejected or expired", 402: "not available on this plan", 403: "token lacks Logs: Read for this project", 429: "rate limited" }[res.status] ?? "API error";
    return fail(`the Supabase logs API answered HTTP ${res.status} (${hint})`);
  }
  let body;
  try { body = await res.json(); } catch { return fail("the Supabase logs API returned something that is not JSON"); }
  if (body && body.error) {
    const code = typeof body.error === "object" && SAFE_CODE.test(String(body.error.status ?? "")) ? ` (${body.error.status})` : "";
    return fail(`the logs query was refused${code}`);
  }
  const rows = checkRows(body?.result, mode);
  if (!rows) return fail("the logs API answer did not have the expected shape (nothing from it is shown)");

  const window = `${iso(start)} to ${iso(end)}`;
  if (mode === "probe") {
    say(`Auth log attribute names, ${window} (names only, no values):`);
    for (const r of rows) say(`  ${r.key}: ${r.n}`);
    return 0;
  }
  // the window was checked: the next run starts here. Review 25 Nov (finding 1): if this checkpoint cannot be saved,
  // the run is a monitor failure (it is not left for the next run to discover).
  let checkpointLost = false;
  try { if (!fs) throw new Error("no storage"); fs.write(`${wmFile}.new`, iso(end)); } catch { checkpointLost = true; }
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (gap) say(`COVERAGE GAP: ${gap}.`);
  if (checkpointLost) say("MONITOR FAILURE: the coverage checkpoint (watermark) could not be saved; the next run cannot start where this one ended.");
  if (total > 0) {
    say(`ALERT: ${total} Auth mail failure(s), ${window}. Sign-in codes may not have reached people.`);
    for (const r of rows) say(`  ${r.task} · ${r.kind}: ${r.n}`);
    say("Look in Supabase → Logs → Auth for this window (the run log deliberately shows counts only).");
    await beat("error");
    return 1;
  }
  const problem = gap || checkpointLost || heartbeatRefused;
  say(`${problem ? "Checked (with the problem above)" : "OK"}: 0 Auth mail failures, ${window}.`);
  if (problem) {
    if (heartbeatRefused && !gap && !checkpointLost) say("MONITOR FAILURE: the heartbeat service did not accept this run's start signal, so the run is not reported as healthy.");
    await beat("error");
    return 2;
  }
  // success is reported only when nothing went wrong, and the run counts as healthy only if the service accepted it
  if (!(await beat("ok"))) {
    say("MONITOR FAILURE: the heartbeat service did not accept this run's success signal; it may be misconfigured.");
    return 2;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const arg = process.argv[2];
  const mode = arg === "probe" || arg === "selftest" ? arg : "check";
  run({ env: process.env, mode, fs: { read: (f) => readFileSync(f, "utf8"), write: (f, t) => writeFileSync(f, t) } }).then((code) => process.exit(code), () => { console.log("MONITOR FAILURE: unexpected error (details withheld)."); process.exit(2); });
}
