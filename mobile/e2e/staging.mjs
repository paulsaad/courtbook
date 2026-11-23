// Prepares and cleans up the staging database for the Android emulator tests. Staging only:
// refuses anything that is not the staging project. Run from mobile/ (uses its supabase-js).
//   node e2e/staging.mjs prepare   → test account, demo club at the desk; writes E2E_* to $GITHUB_ENV
//   node e2e/staging.mjs cleanup   → removes this run's own account, bookings and payments; restores the club
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { recordAndSet, restore } from "./clubMode.mjs";
import { cleanupRunAccount, runEmail } from "./runAccount.mjs";

const STAGING_REF = "pwznauyioqykdwodwpvx";
const LIVE_REF = "lgujfbwunokobjxlvpuf";
const { STAGING_SUPABASE_URL: URL_, STAGING_SERVICE_ROLE_KEY: SERVICE, STAGING_DB_URL: DB, GITHUB_RUN_ID = "local", GITHUB_RUN_ATTEMPT = "1" } = process.env;
for (const [k, v] of Object.entries({ URL_, SERVICE, DB })) if (!v) throw new Error(`${k} missing`);
if (!URL_.includes(STAGING_REF) || URL_.includes(LIVE_REF) || !DB.includes(STAGING_REF) || DB.includes(LIVE_REF)) {
  throw new Error("Refusing: these settings are not the staging project.");
}
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-At", "-c", q], { encoding: "utf8" }).trim();
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const email = runEmail(GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT); // this run and attempt only
const CLUB = sql("select id from clubs where slug='batroun'");
const modeFile = "/tmp/e2e-club-mode.json"; // fresh on every CI runner

async function prepare() {
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser: ${error.message}`);
  sql(`update profiles set name='Emma Tester' where id='${data.user.id}'`);
  // 18+ (0080): automated accounts confirm in server context, so the age question never covers the screen under test
  sql(`do $$ begin update profiles set age_confirmed_at = coalesce(age_confirmed_at, now()), age_confirmed_via = coalesce(age_confirmed_via, 'app') where id = '${data.user.id}'; exception when undefined_column then null; end $$`);
  // The app reserves only at pay-at-the-club clubs (in-app payment is deferred). The original mode is
  // recorded before it is changed, and only a recorded value is ever restored (clubMode.mjs).
  const mode = recordAndSet({ sql, club: CLUB, stateFile: modeFile, runId: GITHUB_RUN_ID });
  const tomorrow = new Date(Date.now() + 26 * 3600e3).toISOString().slice(0, 10);
  const out = { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_CLUB: CLUB, E2E_DATE: tomorrow };
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    console.log(`::add-mask::${password}`);
  }
  console.log(`prepared: account ${email}, demo club ${CLUB} at the desk (was ${mode}), date ${tomorrow}`);
}

function cleanup() {
  // Only this run's own account, bookings and payments; never another run's.
  const left = cleanupRunAccount({ sql, email });
  const r = restore({ sql, club: CLUB, stateFile: modeFile });
  console.log(`cleaned up: ${left} test booking(s) of this run removed, this run's account removed, club mode ${r.restored ? `restored to ${r.mode}` : `not changed — ${r.reason}`}`);
}

const cmd = process.argv[2];
if (cmd === "prepare") await prepare();
else if (cmd === "cleanup") cleanup();
else throw new Error("prepare or cleanup");
