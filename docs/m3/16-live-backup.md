# Live database — manual backup and restore (Free plan: no automatic backups)

Workflow **Database backup (verified)** — `.github/workflows/db-backup.yml`, with the read-only
helpers `.github/scripts/db-snapshot.sql`, `db-security-detail.sql` and `db-security-restore.sql`.
It never writes to the database it backs up. In one run it:

1. dumps roles, schema and data with the Supabase CLI (Supabase's documented method; pinned CLI 3.2.0),
   and writes the source's exact permissions as SQL (`security.sql`);
2. on the source, read only: counts every table and takes one-way hashes of every public table's
   contents, of the accounts (`auth.users`, `auth.identities`) and of the storage records, plus
   fingerprints of row-level security, policies (public and storage), table, column and function
   grants, function code with SECURITY DEFINER and search_path, triggers, constraints, columns and
   sequences, and the Postgres major version;
3. restores roles → schema → data → `security.sql` into a throwaway local Supabase (Postgres 17) on the
   GitHub runner, in one transaction, and takes the same measurements — **all must match**, or
   nothing is kept;
4. encrypts the five files (AES-256, your passphrase), checks the encrypted file opens and holds all
   five, and only then keeps it.

Logs and the run page show object names, numbers and one-way hashes only. Nothing unencrypted leaves
the runner, and the runner is discarded after the run.

**Rehearsed on staging, 20 Nov (runs 44811564817, 44812550022):** 69 tables, 121 checks, 0 different; encryption and
decryption checked with a throwaway key; nothing kept. The deeper check found one real problem on the
way, now fixed: a new Supabase database grants new tables and functions to `anon` / `authenticated`
by default and the dump alone did not take those grants away, so a plain restore gave the public roles
more access than the source. `security.sql` now restores the exact permissions.

## Security review

| Requirement | How it is met |
| --- | --- |
| Live credentials only for authorised runs | The repository is **public** (checked 20 Nov), so environments with required reviewers work on GitHub Free (they would not on a private repository). `LIVE_DB_URL` (present only for the duration of a backup, see the B9 rule below) and `BACKUP_PASSPHRASE` are secrets of the environment `live-backup`, not repository secrets: GitHub releases them only to a job that names that environment, only on `main`, and only after you approve that run. A staging run refuses to start if a live secret is readable as a repository secret. |
| No leak into logs or unencrypted files | Secrets are given only to the steps that use them, never passed between steps; the connection string and its password are both masked; the passphrase goes to gpg on standard input; restore errors print no values; only the encrypted file is uploaded; unencrypted files are deleted and the runner is discarded. |
| Restore verifies more than counts | Data hashes (public tables, accounts, storage records), row-level security, policies, all grants, function code and security settings, triggers, constraints, columns, sequences — see step 2. Tested locally that a changed account, row or policy is detected. |
| Compatible version | Source and restore both Postgres 17; the dump is Supabase's own plain-SQL format; a restore side that is newer is accepted only where it adds empty internal tables or a newer Postgres. |
| No automatic live backup | **No push ever backs up live.** Live only when you start the workflow by hand on `main` and choose source = live; a push (branch `db-backup-staging`) always backs up staging and uses the `staging-backup` environment, which holds no live secret. A changed workflow on another branch is refused by the environment's branch rule and still needs your approval. |

One thing no setting can separate: this assistant's GitHub access acts as your account. The gate stops
other people and other workflows; for the assistant, the rule is that it never starts or approves a live
backup — you do both, by hand, on GitHub.

Remaining limits: a restore into a **hosted** new Supabase project has not been rehearsed (the Free plan
allows two projects, both in use); the rehearsal uses Supabase's local platform, the same one its
restore guide describes. Club photo files are not in the database backup (their records are).

## One-time setup (you, about 15 minutes)

1. **Passphrase.** Make a long one (for example six random words) and save it in your password manager.
   Without it the backup cannot be opened; nobody can recover it.
2. **Live connection string (how to build it; not stored).** Supabase → the **live** project →
   **Connect** → Session pooler → copy. Replace `[YOUR-PASSWORD]` with the live database password from
   your password manager (if unknown: Database → Settings → Database password → Reset password; the
   website and apps use API keys, which don't change). You build it each time you take a live backup
   and paste it straight into GitHub; don't save the finished string anywhere.
3. **GitHub environment.** Repository → Settings → Environments → **New environment** → name
   `live-backup` → Configure:
   - **Required reviewers:** tick it, add yourself (`paulsaad`). Leave "Prevent self-review" off.
   - **Deployment branches and tags:** Selected branches and tags → add `main` only.
   - **Environment secrets:** only **after** the gate proof below — add `BACKUP_PASSPHRASE` (step 1).
     `LIVE_DB_URL` is **not** added here; it is added for each backup and removed after (B9 rule
     below). Never add either under Secrets and variables → Actions (repository secrets).
4. Tell me it's done. I never see either value.

**Prerequisite — the workflow on `main`.** GitHub shows "Run workflow" only for a workflow that exists on
`main`. This needs one small commit to `main` with only `.github/workflows/db-backup.yml` and its three
read-only scripts (no website, app or database change) — your approval required. Vercel rebuilds the
production website from `main` on every commit; the site's code is unchanged.

**Prove the gate before adding the secrets:** create `live-backup` with the reviewer and the branch rule
but **no secrets**, then start a live run by hand. Expected: the run shows **Waiting** for your review;
after you approve, it stops at once with "The LIVE_DB_URL secret is not set". That proves nothing live
runs without your approval. Then add `BACKUP_PASSPHRASE` only.

## Taking the backup

First add `LIVE_DB_URL` to `live-backup` (B9 rule below, step 1); without it the run stops at once
with "The LIVE_DB_URL secret is not set". Then you start it: GitHub → Actions → **Database backup (verified)** → **Run workflow** → branch `main`,
source **live** → Run. GitHub then shows **Review deployments** on the run — approve it there; until you
do, nothing runs and no secret is released. About 10 minutes. On the run page you should see:

- `RESTORE VERIFIED: every row count, data hash …, security setting and schema fingerprint matches`;
- a table of every table's row count, source and restored side by side — check that the game, booking
  and club counts look right to you (live has 4 games that are not cancelled; the table counts all
  games, cancelled ones too);
- `Kept: courtbook-live-<date>.tar.gpg · sha256 …`.

Then: run page → Summary → Artifacts → download it, keep it in two places (your PC and your Google
Drive), check both copies, and remove the artifact and `LIVE_DB_URL` from GitHub the same day (B9 rule
below, steps 3–4). Take a fresh backup immediately before any live migration session.

## Restoring (only if needed)

- **A migration step fails or must be undone:** use that migration's rollback script first (each is
  tested). The backup is the last resort, not the first.
- **Data is lost or the database is damaged:** restore the backup into a **new** Supabase project, never
  over the live one. On the Free plan this means pausing staging first (two active projects at most).
  I run the same restore commands the rehearsal ran, you check the same counts, and then the website and
  apps are pointed at the new project — I would write that plan for your approval at the time.
- **Not in the backup:** the club photo files themselves (their records are included; the M3 migrations
  don't touch them) and project settings such as API keys and sign-in settings (unchanged by migrations).

## Rule since 22 Nov 2026 (B9): no live credential or live data stays on GitHub

Between backups, `live-backup` holds only `BACKUP_PASSPHRASE`. The live database password lives only in
your password manager (it was reset on 22 Nov; the old one is dead). For each live backup:

1. **Before:** add `LIVE_DB_URL` to `live-backup` (connection string as in setup step 2, with the
   current password from your password manager).
2. **Run and approve** the backup as above.
3. **Keep two copies:** download the artifact (a `.zip`) to two places. Check them:
   - the `.tar.gpg` inside: its SHA-256 (`Get-FileHash` in PowerShell) must equal the **Kept:** line
     on the run's Summary page;
   - the `.zip` itself: ask me for GitHub's fingerprint of the artifact and compare both copies;
   - open one `.tar.gpg` in **Command Prompt** (not PowerShell) with
     `gpg --decrypt --output - "FULL_PATH_TO_FILE.tar.gpg" > NUL` and paste the passphrase when asked.
     The decrypted output goes to `NUL` and is discarded; nothing readable is written. Success: gpg
     reports AES256 and returns to the prompt with no error.
4. **Then remove from GitHub, the same day:** delete the artifact from the run (or ask me to delete it
   by its id), and delete `LIVE_DB_URL`. The repository is public: any signed-in GitHub user can
   download a run's artifacts while they exist.

Never reset the database password to an old value. If you suspect the password was seen, reset it in
Supabase → the **live** project → Database → Settings → Database password → Reset password; nothing in
the website or apps uses it.
