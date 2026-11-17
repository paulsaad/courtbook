// Prepares and cleans up the staging database for the Android emulator tests. Staging only:
// refuses anything that is not the staging project. Run from mobile/ (uses its supabase-js).
//   node e2e/staging.mjs prepare   → test account, demo club at the desk; writes E2E_* to $GITHUB_ENV
//   node e2e/staging.mjs cleanup   → removes the run's account, bookings and payments; restores the club
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

const STAGING_REF = "pwznauyioqykdwodwpvx";
const LIVE_REF = "lgujfbwunokobjxlvpuf";
const { STAGING_SUPABASE_URL: URL_, STAGING_SERVICE_ROLE_KEY: SERVICE, STAGING_DB_URL: DB, GITHUB_RUN_ID = "local" } = process.env;
for (const [k, v] of Object.entries({ URL_, SERVICE, DB })) if (!v) throw new Error(`${k} missing`);
if (!URL_.includes(STAGING_REF) || URL_.includes(LIVE_REF) || !DB.includes(STAGING_REF) || DB.includes(LIVE_REF)) {
  throw new Error("Refusing: these settings are not the staging project.");
}
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-At", "-c", q], { encoding: "utf8" }).trim();
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const email = `e2e-android-${GITHUB_RUN_ID}@courtbook.test`;
const CLUB = sql("select id from clubs where slug='batroun'");
const stateFile = "/tmp/e2e-state.json";

async function prepare() {
  const mode = sql(`select payment_mode from clubs where id='${CLUB}'`);
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser: ${error.message}`);
  sql(`update profiles set name='Emma Tester' where id='${data.user.id}'`);
  // The app reserves only at pay-at-the-club clubs (in-app payment is deferred).
  sql(`update clubs set payment_mode='at_desk' where id='${CLUB}'`);
  fs.writeFileSync(stateFile, JSON.stringify({ mode, userId: data.user.id }));
  const tomorrow = new Date(Date.now() + 26 * 3600e3).toISOString().slice(0, 10);
  const out = { E2E_EMAIL: email, E2E_PASSWORD: password, E2E_CLUB: CLUB, E2E_DATE: tomorrow };
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    console.log(`::add-mask::${password}`);
  }
  console.log(`prepared: account ${email}, demo club ${CLUB} at the desk (was ${mode}), date ${tomorrow}`);
}

function cleanup() {
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { mode: "simulated" };
  const mine = `(select id from auth.users where email like 'e2e-android-%@courtbook.test')`;
  const left = sql(`select count(*) from bookings where player_id in ${mine}`);
  sql(`delete from payments where booking_id in (select id from bookings where player_id in ${mine});
       delete from bookings where player_id in ${mine};
       delete from auth.users where email like 'e2e-android-%@courtbook.test';
       update clubs set payment_mode='${st.mode}' where id='${CLUB}';`);
  console.log(`cleaned up: ${left} test booking(s) removed, test accounts removed, club mode ${st.mode}`);
}

const cmd = process.argv[2];
if (cmd === "prepare") await prepare();
else if (cmd === "cleanup") cleanup();
else throw new Error("prepare or cleanup");
