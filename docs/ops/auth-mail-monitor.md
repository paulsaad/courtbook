# Auth mail monitor (B5): alert proof, coverage, real-log validation

Status: **inactive**. Draft PR #60. Nothing here has been run against a real project, and no credential exists.

Files: `scripts/auth-mail-monitor.mjs` (43 offline tests in `scripts/auth-mail-monitor.nodetest.mjs`),
`.github/workflows/auth-mail-monitor.yml`.

The monitor stays inactive until all three checks below pass (review of 25 Nov):

1. A controlled failure is proved to reach Paul, through GitHub email AND the heartbeat service.
2. The coverage design (below) is accepted.
3. The query is validated against real, sanitized Auth log examples of one failed and one successful email.

---

## 1. Alerts: a heartbeat service is required (finding 1)

GitHub emails about a failed run only if the account's notification settings allow it. For scheduled runs, the email
goes to the user who last changed the cron line. A run that never starts produces no email at all. So GitHub email
alone is not enough.

**What the code does now:**

- Every `check` or `selftest` run needs exactly one heartbeat service. With none, or with both, the run fails before
  it reads any log.
- Each run sends start, then success (exit 0) or failure (exit 1 or 2), all with one run id.
- **A heartbeat the service does not accept** (no answer, or HTTP 4xx/5xx) makes the run a monitor failure (exit 2),
  even when the logs were checked cleanly. After a refused start signal, success is never sent: the run ends with a
  failure signal instead. A refused success signal also gives exit 2 (review 25 Nov, finding 2). Typical causes: a
  wrong or deleted ping URL (404), a revoked key (403), rate limiting (429).
- The service reports a run that fails. It also reports a run that never happens: schedule disabled, GitHub outage,
  GitHub's 60-day inactivity pause, or a start later than the 30-minute grace.

### Decision D1: which heartbeat service — **decided 25 Nov (Paul): Healthchecks.io, free plan**

**Finding while preparing this:** the Sentry organisation is on the free Developer plan. That plan includes one cron
monitor, and `deletion-retry` (the staging trial) already uses it. A Developer-plan organisation cannot add monitors.
Making Sentry Crons mandatory therefore needs a paid plan. The code supports both options below.

| Option | Cost | Setup (Paul) | Notes |
| --- | --- | --- | --- |
| **A. Healthchecks.io, free Hobbyist plan (recommended)** | $0 (20 checks) | Sign up. Create check `auth-mail-monitor` with cron `17 * * * *`, time zone UTC, grace 30 min, email to Paul. Store its ping URL as secret `AUTH_MONITOR_HEALTHCHECKS`. | Open source and widely used. Only heartbeats are sent: no data, no log lines. |
| B. Sentry Team plan | $26/month + $0.78/month for the second monitor | Upgrade. Set alert rules for the new monitor. Store the check-in URL as secret `AUTH_MONITOR_SENTRY_CRONS`. | The monitor creates itself on the first check-in (schedule sent by the script). |
| ~~C. Reuse the `deletion-retry` monitor~~ | — | — | Rejected: it would change the trial. |

### Prerequisite: the workflow must be on `main`

GitHub runs schedules, and offers "Run workflow", only for workflows on the default branch. So the alert tests need #60
merged into `main` **while it is inactive**:

- With `AUTH_MONITOR_PROJECT_REF` and `AUTH_MONITOR_SELFTEST` unset, every hourly trigger shows as a skipped job.
  Nothing runs and nothing is read.
- **Merging into `main` redeploys the live website through Vercel.** The app code is identical: the change is only a
  script, its test, this document and the workflow file. It is still a production deploy, so it needs Paul's explicit
  go.

### Tests T1–T3 (each with Paul's go, after D1 and the merge)

Before T1, Paul checks GitHub → Settings → Notifications → **Actions**: notifications by email, at least for failed
workflows.

**T1. Manual selftest (GitHub email to the person who starts the run, plus a service alert)**

1. GitHub → Actions → "Auth mail monitor" → Run workflow → mode `selftest` → Run.
2. Expect:
   - the run turns red within about a minute, with the line `SELFTEST: a deliberate monitor failure (no logs were
     read)`;
   - a GitHub email "Run failed: Auth mail monitor";
   - an alert email from the service.
3. Paul records the time of each email.

**T2. Scheduled selftest (proves the schedule fires on `main`, and who gets the scheduled-run email)**

1. Add the repository variable `AUTH_MONITOR_SELFTEST` = `true`.
2. Wait for the next :17 run. GitHub may start it late.
3. Expect the same two emails as in T1.
4. Delete the variable.
5. **If no GitHub email arrives:** the commits are authored by Claude and pushed with Paul's account, and it is not
   documented which of these GitHub treats as "last changed the cron line". Fix: Paul edits the cron line in GitHub's
   web editor (for example, adds then removes a space), and T2 is repeated.

**T3. Missed run (a run that never happens is reported)**

1. Bring the check back to "up":
   - Healthchecks: open the ping URL once in a browser (that is a success ping).
   - Sentry: it recovers on the next good check-in, or after the selftest.
2. With both variables unset, no run checks in.
3. Expect a "missed" or "down" alert from the service within about 90 minutes.

**Pass:** all expected emails arrive (T1: 2, T2: 2, T3: 1). Otherwise the monitor stays inactive and the failure is
reported.

---

## 2. Coverage (finding 2)

The old design checked a fixed 70-minute lookback each hour. A run delayed by more than 10 minutes left a hole.

**The new design:**

- **Watermark.** Each run checks from the end of the previous *successful* check to now minus **15 minutes**
  (`INGEST_LAG_MINUTES`). The end point is saved as a watermark in the Actions cache. A late run checks a longer window,
  so windows chain without holes whatever GitHub's delay.
- **Only a checked window moves the watermark.** A failed query leaves it unchanged, so the next run repeats the window.
- **The checkpoint must be saved** (review 25 Nov, finding 1). If the script cannot write the new watermark, the run is
  a monitor failure (exit 2, failure signal, never "OK"), or exit 1 if mail failures were also found. The old
  watermark is left as it was.
- **After the script, the workflow saves the watermark to the Actions cache.** GitHub's cache-save step only warns if it
  fails. That case is safe by construction: the next run restores the previous saved watermark, which is older, so it
  checks a longer window (overlap, no hole). If saves keep failing for 24 hours, the gap alert fires.
- **The API allows at most 24 hours per query.** If the watermark is older than that, or missing, the run still checks
  the last 24 hours and reports a **COVERAGE GAP**: exit 2 and a heartbeat failure alert. The only exception is the
  first run, started by hand with `first_run` = true.
- **No overlapping runs** (concurrency group, no cancellation).
- **Re-runs** use a per-attempt cache key, so they never collide.

**Offline tests:**

- a run delayed 3 h 42 min is fully covered;
- irregular runs chain with no hole and no overlap;
- a watermark older than 24 h reports a gap;
- a missing watermark reports a gap, unless `first_run`;
- a failed query does not move the watermark;
- gap and failures together are both reported;
- a watermark that cannot be written, or no watermark storage at all, is a monitor failure (with or without mail
  failures);
- heartbeat answers 404 (start), 500 (success), 403 (all) and 429 (start, with mail failures) each fail the run and never
  report it healthy; a selftest with a refused heartbeat still exits 2.

Two deliberately broken copies of the script were run against the tests:

- one ignores the checkpoint failure: 3 tests fail;
- one treats an HTTP 4xx/5xx heartbeat as accepted: 3 tests fail.

**Residual risks (stated, not hidden):**

1. **Late ingestion.** An Auth event that reaches the logs more than 15 minutes after its own timestamp would fall
   before the watermark and be missed. This cannot be measured from outside. 15 minutes is a conservative assumption,
   to revisit if the validation in §3 shows events arriving late. The cost is alert latency only: a failure is reported
   15 to 75 minutes after it happens.
2. **The Actions cache is best-effort.** If the watermark is lost (for example, evicted after 7 days without runs), the
   next run reports a gap. Never silent.
3. **A start delayed beyond 30 minutes** gives a "missed" alert even though coverage stays complete. That is a false
   alarm, accepted.

---

## 3. Real-log validation (finding 3)

The 43 offline tests prove the script's logic and privacy handling. They do not prove that real Supabase Auth logs:

- carry the fields the query uses: `log_attributes['action'] = 'apitask'`, `['task_type'] = 'mailer.*'` and
  `['level'] = 'error'`;
- write the message text the query classifies by;
- log nothing that the query would count for a *successful* email.

Only real examples settle this.

### Where, and who

- Supabase dashboard → **staging** project → Logs → **Logs Explorer**.
- Read-only. Paul runs the queries. I do not sign in to the dashboard.
- If the Explorer rejects the SQL dialect, Paul pastes the error text. I adjust the query; nothing is guessed.
- Paul glances at results before pasting them into chat. The masking below should leave no address, id, IP or token,
  but a human check is the last line of defence.
- Staging log retention is short (about 1 day on the free plan). So V1–V3 run within a day of the example events.

### V1. Attribute names (no values)

```sql
select arrayJoin(mapKeys(log_attributes)) as key, count() as n
from logs
where source = 'auth_logs'
group by key
order by key
limit 200
```

### V2. Sanitized sample of mail-related Auth events

```sql
select
  timestamp,
  log_attributes['action']    as action,
  log_attributes['task_type'] as task_type,
  log_attributes['level']     as level,
  replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(event_message,
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', '<email>'),
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>'),
    '\\b[0-9]{1,3}(\\.[0-9]{1,3}){3}\\b', '<ip>'),
    '[A-Za-z0-9_-]{24,}', '<token>') as message_sanitized
from logs
where source = 'auth_logs'
  and (positionCaseInsensitive(event_message, 'mail') > 0 or log_attributes['task_type'] like 'mailer.%')
order by timestamp desc
limit 50
```

The masking was checked on ClickHouse. A synthetic line containing an email address, a user id and an IP came out as
`... smtp 535 for <email> user <uuid> from <ip>`. If V1 shows other attribute names that look relevant (for example a
status or error field), I extend V2 with those names only, never with values that could identify a person.

### V3. The monitor's own query over the same window

`CHECK_SQL` from `scripts/auth-mail-monitor.mjs`, pasted as is. It returns `kind`, `task` and `n` only.

### The example events (after the deletion trial is evaluated, each with Paul's go)

Generating examples writes to staging Auth (a one-time code, and possibly a user). That changes staging data, so it
waits until the trial's final evaluation (27 Nov, about 17:55 UTC).

| Example | How | Clean-up |
| --- | --- | --- |
| **S. Successful email** | Request a sign-in code on the staging site for Paul's existing staging tester address. The code arrives. | None: existing account, no sign-in needed. |
| **F. Failed email (recommended)** | Supabase → staging → Authentication → SMTP settings: change only the **host** to `smtp.invalid`, save. Request one sign-in code for the same tester address. Restore the original host, save. Request one more code to confirm mail works again. | Host restored. No password re-entry, no new user. |
| F′. Optional | Request a code for an address at a reserved non-existent domain (`…@example.invalid`). The SMTP service may refuse it (an Auth error) or accept it and bounce later (no Auth error). Either result is informative: the second shows a class of failure the monitor cannot see. | Delete the user it creates (separate approval). |

**F is unverified on two points.** Whether Supabase tests the SMTP host when the settings are saved is not documented.
If it refuses the save, F is replaced by F′ or another method, and that is reported. While the host is wrong (about two
minutes), staging cannot send email.

### Pass criteria

1. V2 shows the failed send (F) with the fields the query relies on, and V3 counts it once, under the right task
   (`mailer.magiclink` or similar).
2. V2 shows the successful send (S), and V3 counts nothing for it.
3. No other Auth error in the window is counted by V3 (no false positives against V2).
4. No message in V2 shows a timestamp suggesting ingestion beyond 15 minutes. This is only a weak check; see §2.

If any criterion fails, I correct the query, add the real (sanitized) shapes as offline tests, and run V1–V3 again.

---

## 4. Activation (later, each step with Paul's go)

1. D1 decided. #60 merged into `main`, inactive (a production redeploy with unchanged app code).
2. T1, T2 and T3 pass.
3. After the trial: S and F (or F′), then V1–V3 pass.
4. Paul creates the Supabase scoped token: **one project, Logs: Read only, with an expiry**. Stored as secret
   `AUTH_MONITOR_LOGS_TOKEN` in the GitHub environment `auth-monitor`.
5. Decision D2: which project is monitored. Recommended: **production** (that is where people request codes). The log
   format is the same as staging; V1 is repeated read-only on production first.
6. One manual run: mode `check`, `first_run` = true. Expect exit 0 and the heartbeat "up".
7. Set `AUTH_MONITOR_PROJECT_REF`. From then on it runs hourly.

**Turning it off:** delete the variable `AUTH_MONITOR_PROJECT_REF`. The job is skipped from the next hour. Pause the
check in the heartbeat service at the same time, or it will report missed runs.
