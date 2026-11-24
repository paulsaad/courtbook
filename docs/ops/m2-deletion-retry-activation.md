# M2 (0086): activating automatic deletion retries (R1) — NOT APPLIED

Status: **prepared, not active.** No scheduler is configured, no `CRON_SECRET` is set anywhere, and `vercel.json` is
unchanged. Activation needs Paul's separate approval, after 0086 is on the environment concerned.

**Release gate (PR #18 review, 23 Nov, finding 1):** the app's one-step deletion is released on an environment only
after R1 is active and verified there (docs/ops/m2-0086-rollout.md, step 3). The database enforces it too: each run
that gets through records a heartbeat (`deletion_worker`), and `close_my_account('app')` refuses with
`processing_unavailable` when there has been no run in the last hour. The website is not gated (it processes inline).
Watch it: `staging-db` → `m86_worker_check` (read only), or the line at the top of `/admin/deletions`.

## What exists in code

`GET|POST /api/internal/deletions/retry` (src/app/api/internal/deletions/retry/route.ts):

- **Authorisation:** `Authorization: Bearer <CRON_SECRET>`, compared as SHA-256 digests in constant time.
  - With no `CRON_SECRET`, or one shorter than 32 characters, it answers **503 `not_configured`** and does nothing.
  - A wrong or missing header gets **401**.
  - It reads no cookie and no session, and takes no input: what to process comes from `deletions_due()` in the
    database.
- **Work:** up to 20 records per call, and no new record started after 40 s (`maxDuration` 60 s). Each record:
  1. is leased for 5 minutes, so overlapping calls never process the same record;
  2. continues from its first missing step (src/lib/deletion/pipeline.ts);
  3. on failure, records an error code and waits out the backoff before the next try: 1 min, 5 min, 15 min, 1 h,
     then every 6 h.
- **Alerts:** one fixed Sentry message per record needing a person ("account: deletion needs attention", tag
  `code=held|stuck`, no account id). The record is then marked `alerted_at`. The R2 proposal says what turns this into
  an email.
- **Answer:** counts only, `{done, held, skipped, failed, lease_lost, remaining, alerts}`.

Until activation, the admin's **Retry now** on `/admin/deletions` runs the same steps for one record.

**What waits on this.** App closures run only step A (close) on the phone. Steps B to E (ban, data, sign-in deletion,
finish) wait for this route or for an admin. Website closures run B to E inline, so they wait only when a step fails.

## Options (choose one)

| Option | Cost / plan | Frequency | Setup |
| --- | --- | --- | --- |
| **A. Vercel Cron** (proposal R1) | Vercel Pro (L7); Hobby allows one run a day | Hourly (`0 * * * *`) | `vercel.json` `crons` entry; `CRON_SECRET` in the project's environment variables. Vercel sends the bearer header itself |
| B. GitHub Actions schedule (fallback) | Free | Every 15 min (GitHub may delay or skip runs) | Workflow with `schedule:`; the secret as a repository secret; `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/internal/deletions/retry` |
| C. Supabase pg_cron + pg_net | Free | Any | Extensions plus the secret in Supabase Vault. pg_net does not retry and keeps responses in a table. More moving parts; the M3 push design anticipates it, but nothing is set up today |

Recommendation: **B now** (prepared as `.github/workflows/deletion-retry.yml`), because it works on the free plans and
for staging. Vercel runs crons only for production deployments, so A cannot drive staging at all. Move production to A
later if Pro is approved for other reasons (L7).

**Staging is behind Vercel login** (Standard Protection, no bypass; inventory of 22 Nov). A caller from outside needs
Vercel's **Protection Bypass for Automation** secret, sent as the `x-vercel-protection-bypass` header. Turning that
on is a Vercel setting: Paul's decision. The production domain is not protected.

## Steps for option A, when approved (staging first)

1. Generate a secret locally, at least 32 characters: `openssl rand -base64 48`. Never paste it into chat, a commit or
   a log.
2. Vercel → Project → Settings → Environment Variables:
   - add `CRON_SECRET` for **Preview** (staging) only;
   - leave Production for later, after the staging check.
3. Add to `vercel.json` (a reviewed commit, not done here):
   ```json
   { "regions": ["fra1"], "crons": [{ "path": "/api/internal/deletions/retry", "schedule": "0 * * * *" }] }
   ```
   Vercel only runs crons for production deployments. For staging, call the route by hand (step 4) or use option B.
4. Check, after redeploying:
   - `curl -i https://<staging>/api/internal/deletions/retry` gives **401**;
   - with the header it gives **200** and counts;
   - with no `CRON_SECRET` set it gives **503**.
5. Watch the first runs: `/admin/deletions` shows attempts and last errors, and the Vercel logs show status codes only.

## Steps for option B, when approved (the workflow file is prepared: `.github/workflows/deletion-retry.yml`)

It runs every 15 minutes (`7,22,37,52 * * * *`) and on demand. It has no checkout and no permissions. It makes one
POST per target that is configured; a target that is not configured is skipped and nothing is called. GitHub runs
schedules only from `main`, so the file does nothing until merged.

**Staging:**

1. Vercel → Settings → Deployment Protection → **Protection Bypass for Automation** → generate (Paul).
2. Repository secrets:
   - `CRON_SECRET_STAGING`: the same value as Vercel's `CRON_SECRET` for Preview, at least 32 characters;
   - `VERCEL_BYPASS_STAGING`: the bypass from step 1.
3. Repository variable `DELETION_RETRY_URL_STAGING`: `https://<staging alias>/api/internal/deletions/retry`.
4. Run the workflow by hand once and expect `staging: HTTP 200 {…counts…}`. Then `staging-db` → `m86_worker_check`
   should show the run.

**Production:**

1. Secret `CRON_SECRET`, the same value as Vercel's Production `CRON_SECRET`.
2. Variable `DELETION_RETRY_URL`: `https://<production domain>/api/internal/deletions/retry`.

**Notes:**

- GitHub may delay scheduled runs by several minutes. The 1-hour heartbeat window tolerates that.
- If runs stop, app deletions pause; they do not pile up.
- A failed run (any status but 200) fails the workflow. GitHub emails the person who last changed the schedule.

## Turning it off

Remove the cron entry or workflow. Or remove `CRON_SECRET`: the route then answers 503 and does nothing.
Nothing is lost while it is off: due records wait, and the admin page can Retry them.
