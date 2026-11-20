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

**Rehearsed on staging, 20 Nov (run 44811564817):** 69 tables, 121 checks, 0 different; encryption and
decryption checked with a throwaway key; nothing kept. The deeper check found one real problem on the
way, now fixed: a new Supabase database grants new tables and functions to `anon` / `authenticated`
by default and the dump alone did not take those grants away, so a plain restore gave the public roles
more access than the source. `security.sql` now restores the exact permissions.

## Security review

| Requirement | How it is met |
| --- | --- |
| Live credentials only for authorised runs | `LIVE_DB_URL` and `BACKUP_PASSPHRASE` are secrets of the GitHub environment `live-backup`, not repository secrets. GitHub releases them only to a job that names that environment, only from the branches it allows (`db-backup-live`, later `main`), and only after you approve that run on GitHub. A staging run refuses to start if a live secret is readable as a repository secret. |
| No leak into logs or unencrypted files | Secrets are given only to the steps that use them, never passed between steps; the connection string and its password are both masked; the passphrase goes to gpg on standard input; restore errors print no values; only the encrypted file is uploaded; unencrypted files are deleted and the runner is discarded. |
| Restore verifies more than counts | Data hashes (public tables, accounts, storage records), row-level security, policies, all grants, function code and security settings, triggers, constraints, columns, sequences — see step 2. Tested locally that a changed account, row or policy is detected. |
| Compatible version | Source and restore both Postgres 17; the dump is Supabase's own plain-SQL format; a restore side that is newer is accepted only where it adds empty internal tables or a newer Postgres. |
| Staging branch cannot start a live backup | Live only when the branch is `db-backup-live` (or a hand-started run on `main` choosing live). Any other branch backs up staging and names the `staging-backup` environment, which holds no live secret; even a changed workflow on another branch is refused by the environment's branch rule and still needs your approval. |

Remaining limits: a restore into a **hosted** new Supabase project has not been rehearsed (the Free plan
allows two projects, both in use); the rehearsal uses Supabase's local platform, the same one its
restore guide describes. Club photo files are not in the database backup (their records are).

## One-time setup (you, about 15 minutes)

1. **Passphrase.** Make a long one (for example six random words) and save it in your password manager.
   Without it the backup cannot be opened; nobody can recover it.
2. **Live connection string.** Supabase → the **live** project → **Connect** → Session pooler → copy.
   Replace `[YOUR-PASSWORD]` with the live database password (if unknown: Project Settings → Database →
   Reset database password; the website and apps use API keys, which don't change).
3. **GitHub environment.** Repository → Settings → Environments → **New environment** → name
   `live-backup` → Configure:
   - **Required reviewers:** tick it, add yourself (`paulsaad`). Leave "Prevent self-review" off.
   - **Deployment branches and tags:** Selected branches and tags → add `db-backup-live` (and `main`).
   - **Environment secrets:** add `LIVE_DB_URL` (step 2) and `BACKUP_PASSPHRASE` (step 1).
   Do **not** add them under Secrets and variables → Actions (repository secrets).
4. Tell me it's done. I never see either value.

## Taking the backup

With your approval I start it (until the workflow is on `main`, by pushing to the branch
`db-backup-live`). GitHub then shows **Review deployments** on the run — you approve it there; until you
do, nothing runs and no secret is released. About 10 minutes. On the run page you should see:

- `RESTORE VERIFIED: every row count, data hash …, security setting and schema fingerprint matches`;
- a table of every table's row count, source and restored side by side — check that the game, booking
  and club counts look right to you (live has 4 games that are not cancelled; the table counts all
  games, cancelled ones too);
- `Kept: courtbook-live-<date>.tar.gpg · sha256 …`.

Then: run page → Summary → Artifacts → download it, and keep it in two places (your PC and your Google
Drive). Keep it until the M3 release is finished and checked. Take a fresh backup immediately before the
live migration session as well.

## Restoring (only if needed)

- **A migration step fails or must be undone:** use that migration's rollback script first (each is
  tested). The backup is the last resort, not the first.
- **Data is lost or the database is damaged:** restore the backup into a **new** Supabase project, never
  over the live one. On the Free plan this means pausing staging first (two active projects at most).
  I run the same restore commands the rehearsal ran, you check the same counts, and then the website and
  apps are pointed at the new project — I would write that plan for your approval at the time.
- **Not in the backup:** the club photo files themselves (their records are included; the M3 migrations
  don't touch them) and project settings such as API keys and sign-in settings (unchanged by migrations).

## After the release

Delete the `LIVE_DB_URL` secret (or reset the database password), so no live credential stays stored.
