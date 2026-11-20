# Live database — manual backup and restore (Free plan: no automatic backups)

Workflow **Database backup (verified)** (`.github/workflows/db-backup.yml`). It never writes to the
database it backs up. In one run it:

1. dumps roles, schema and data with the Supabase CLI (Supabase's documented backup method; includes
   all tables, functions, policies, triggers and the accounts in `auth.users`);
2. counts every table and fingerprints the schema on the source, read only;
3. restores the dump into a throwaway local Supabase on the GitHub runner, exactly as Supabase's
   restore guide does, and counts again — **every count and fingerprint must match**, or nothing is kept;
4. only then encrypts the dump (AES-256, your passphrase) and keeps it as a downloadable file.

Logs and the run page show table names and numbers only — never names, emails or phones. Nothing
unencrypted leaves the runner. (Files kept by a public repository can be downloaded by any GitHub
user, which is why the file is encrypted and the passphrase is only yours.)

**Rehearsed on staging, 20 Nov (run 44807970003):** 69 tables, restored in one transaction, 79 checks
compared, 0 different. Two empty tables exist only on the newer local test platform; they are reported,
not counted as differences.

## One-time setup (you, about 10 minutes)

1. **Passphrase.** Make a long one (for example five or six random words). Save it in your password
   manager. Without it the backup cannot be opened; nobody can recover it.
2. **GitHub** → the `courtbook` repository → Settings → Secrets and variables → Actions → New repository
   secret: name `BACKUP_PASSPHRASE`, value = the passphrase.
3. **Supabase** → the **live** project → **Connect** (top of the page) → Session pooler → copy the
   connection string. Replace `[YOUR-PASSWORD]` with the live database password. (If you don't know it:
   Project Settings → Database → Reset database password. The website and apps don't use this password;
   they use the API keys, which don't change.)
4. **GitHub** → New repository secret: name `LIVE_DB_URL`, value = that connection string.
5. Tell me it's done. I don't see either value.

## Taking the backup

With your approval I start it (until the workflow is on `main`, it starts from the branch
`db-backup-live`). About 10 minutes. On the run page you should see:

- `RESTORE VERIFIED: every table count and schema fingerprint matches`;
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
