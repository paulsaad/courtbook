// Paul's own sign-in for the CourtBook Staging app (staging database only). Creates the account
// paul.tester@courtbook.test, or sets its password again, with the password Paul chose and stored as
// the GitHub secret STAGING_TESTER_PASSWORD. The password is never printed. Also puts the demo club on
// pay-at-the-club, the only mode the app books in while in-app payment is deferred.
// Run by the "Staging database" workflow, action "tester".
import { execFileSync } from "node:child_process";

const STAGING_REF = "pwznauyioqykdwodwpvx";
const LIVE_REF = "lgujfbwunokobjxlvpuf";
const { STAGING_SUPABASE_URL: URL_, STAGING_SERVICE_ROLE_KEY: SERVICE, STAGING_DB_URL: DB, STAGING_TESTER_PASSWORD: PASSWORD } = process.env;
for (const [k, v] of Object.entries({ STAGING_SUPABASE_URL: URL_, STAGING_SERVICE_ROLE_KEY: SERVICE, STAGING_DB_URL: DB, STAGING_TESTER_PASSWORD: PASSWORD }))
  if (!v) { console.error(`::error::${k} is not set`); process.exit(1); }
if (new URL(URL_.trim()).host !== `${STAGING_REF}.supabase.co` || !DB.includes(STAGING_REF) || (URL_ + DB).includes(LIVE_REF)) {
  console.error("::error::Refusing: these settings are not the staging project."); process.exit(1);
}
if (PASSWORD.length < 12) { console.error("::error::STAGING_TESTER_PASSWORD must be at least 12 characters"); process.exit(1); }

const EMAIL = "paul.tester@courtbook.test";
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-At", "-c", q], { encoding: "utf8" }).trim();
const base = URL_.trim().replace(/\/$/, "") + "/auth/v1/admin/users";
const headers = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" };

const existing = sql(`select id from auth.users where email='${EMAIL}'`);
let id = existing;
if (existing) {
  const r = await fetch(`${base}/${existing}`, { method: "PUT", headers, body: JSON.stringify({ password: PASSWORD, email_confirm: true }) });
  if (!r.ok) { console.error(`::error::password update failed: HTTP ${r.status}`); process.exit(1); }
  console.log(`account ${EMAIL}: existed, password set from the secret`);
} else {
  const r = await fetch(base, { method: "POST", headers, body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }) });
  if (!r.ok) { console.error(`::error::create failed: HTTP ${r.status}`); process.exit(1); }
  id = (await r.json()).id;
  console.log(`account ${EMAIL}: created`);
}
sql(`update profiles set name='Paul Tester' where id='${id}'`);
console.log(sql(`update clubs set payment_mode='at_desk' where slug='batroun' returning 'demo club ' || name || ': ' || payment_mode`));
