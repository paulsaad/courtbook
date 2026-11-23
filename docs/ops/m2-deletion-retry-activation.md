# M2 (0086): activating automatic deletion retries (R1) — NOT APPLIED

Status: **prepared, not active.** No scheduler is configured, no `CRON_SECRET` is set anywhere, and `vercel.json` is
unchanged. Activation needs Paul's separate approval, after 0086 is on the environment concerned.

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

Recommendation: **A** if Pro is approved for other reasons (L7), otherwise **B**.

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

## Steps for option B, when approved

1. Repository secret `CRON_SECRET_STAGING` (the same value as Vercel's `CRON_SECRET` for Preview).
2. `.github/workflows/deletion-retry.yml`:
   - `on: schedule: - cron: "*/15 * * * *"` plus `workflow_dispatch`;
   - one `curl -fsS` step;
   - no checkout, no other permissions (`permissions: {}`).
3. Same checks as A, step 4.

## Turning it off

Remove the cron entry or workflow. Or remove `CRON_SECRET`: the route then answers 503 and does nothing.
Nothing is lost while it is off: due records wait, and the admin page can Retry them.
