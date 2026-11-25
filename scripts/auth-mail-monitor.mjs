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
 * Exit codes: 0 = checked, no mail failures; 1 = mail failures found (alert); 2 = the monitor could not check (alert).
 * Optional heartbeat: SENTRY_CRONS_URL (a Sentry Crons check-in URL). in_progress at the start, ok on 0, error on 1 or
 * 2; a run that never happens is reported by Sentry as missed. A failed heartbeat never changes the exit code.
 *
 * Modes: `check` (default) as above; `probe` lists the attribute KEYS present on Auth log events in the window (names
 * only, never values), to confirm once that the attribute names this query uses exist.
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

async function heartbeat(fetchImpl, url, status, log) {
  if (!url) return;
  try {
    const u = new URL(url);
    u.searchParams.set("status", status);
    const r = await fetchImpl(u.toString(), { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) log(`heartbeat: Sentry answered HTTP ${r.status} (status ${status} not recorded)`);
  } catch {
    log(`heartbeat: could not reach Sentry (status ${status} not recorded)`);
  }
}

export async function run({ env, fetch: fetchImpl = fetch, now = () => new Date(), log = console.log, mode = "check" }) {
  const token = env.SUPABASE_ACCESS_TOKEN ?? "";
  const ref = env.PROJECT_REF ?? "";
  const minutes = Number(env.WINDOW_MINUTES ?? 70);
  const cron = env.SENTRY_CRONS_URL || "";
  const say = (t) => log(safe(t));
  if (mode === "check") await heartbeat(fetchImpl, cron, "in_progress", say);
  const fail = async (why) => {
    say(`MONITOR FAILURE: ${why}. Mail failures could not be checked for this window.`);
    if (mode === "check") await heartbeat(fetchImpl, cron, "error", say);
    return 2;
  };

  if (!token) return fail("no logs token (SUPABASE_ACCESS_TOKEN) is configured");
  if (!REF.test(ref)) return fail("PROJECT_REF is missing or not a project reference");
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) return fail("WINDOW_MINUTES must be 5 to 1440 (the API allows at most 24 hours)");

  const end = now();
  const start = new Date(end.getTime() - minutes * 60_000);
  const url = new URL(`https://api.supabase.com/v1/projects/${ref}/analytics/endpoints/logs`);
  url.searchParams.set("sql", mode === "probe" ? PROBE_SQL : CHECK_SQL);
  url.searchParams.set("iso_timestamp_start", start.toISOString());
  url.searchParams.set("iso_timestamp_end", end.toISOString());

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

  const window = `${start.toISOString()} to ${end.toISOString()}`;
  if (mode === "probe") {
    say(`Auth log attribute names, ${window} (names only, no values):`);
    for (const r of rows) say(`  ${r.key}: ${r.n}`);
    return 0;
  }
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (total === 0) {
    say(`OK: 0 Auth mail failures, ${window}.`);
    await heartbeat(fetchImpl, cron, "ok", say);
    return 0;
  }
  say(`ALERT: ${total} Auth mail failure(s), ${window}. Sign-in codes may not have reached people.`);
  for (const r of rows) say(`  ${r.task} · ${r.kind}: ${r.n}`);
  say("Look in Supabase → Logs → Auth for this window (the run log deliberately shows counts only).");
  await heartbeat(fetchImpl, cron, "error", say);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] === "probe" ? "probe" : "check";
  run({ env: process.env, mode }).then((code) => process.exit(code), () => { console.log("MONITOR FAILURE: unexpected error (details withheld)."); process.exit(2); });
}
