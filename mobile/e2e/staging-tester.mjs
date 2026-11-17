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

const id = sql(`select id from auth.users where email='${EMAIL}'`);
console.log(`account ${EMAIL}: ${id ? "exists (password NOT changed by this diagnostic run)" : "MISSING"}`);
console.log(sql(`select 'demo club ' || name || ': ' || payment_mode from clubs where slug='batroun'`));

// --- diagnostic (branch staging-tester-check only): sign in with the secret the way the app does.
// Prints only facts about the password, never the password.
const ANON = process.env.STAGING_ANON_KEY;
const p = PASSWORD;
console.log(`secret: ${p.length} characters; leading/trailing space or line break: ${p !== p.trim() ? "YES" : "no"}; line break anywhere: ${/[\r\n]/.test(p) ? "YES" : "no"}; non-ASCII characters: ${/[^\x20-\x7e]/.test(p) ? "YES" : "no"}; has lower/upper/digit/symbol: ${[/[a-z]/,/[A-Z]/,/[0-9]/,/[^A-Za-z0-9]/].map((r) => r.test(p) ? "y" : "n").join("/")}; characters adb-typing may alter (space " ' \\ & | ; < > ( ) $ \` % ~ *): ${/[ "'\\&|;<>()$`%~*]/.test(p) ? "YES" : "no"}`);
console.log("sign-in history of this account (auth audit log, newest first; IP shortened):");
console.log(sql(`select string_agg(to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI') || ' UTC  ' || coalesce(payload->>'action','?') || '  from ' || coalesce(split_part(host(ip_address::inet),'.',1)||'.'||split_part(host(ip_address::inet),'.',2)||'.x.x', ip_address::text, '?'), E'\n' order by created_at desc) from (select * from auth.audit_log_entries where payload->>'actor_username' = '${EMAIL}' or payload->'traits'->>'user_email' = '${EMAIL}' order by created_at desc limit 25) a`) || "(no entries)");
console.log("last sign-in recorded on the account: " + sql(`select coalesce(to_char(last_sign_in_at at time zone 'UTC','YYYY-MM-DD HH24:MI') || ' UTC','never') || '; password last set: ' || coalesce(to_char(updated_at at time zone 'UTC','YYYY-MM-DD HH24:MI') || ' UTC','?') from auth.users where email='${EMAIL}'`));
const auth = URL_.trim().replace(/\/$/, "") + "/auth/v1/token?grant_type=password";
for (const [label, pw] of [["exactly as saved", p], ["with spaces trimmed", p.trim()]]) {
  const r = await fetch(auth, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: pw }) });
  const j = await r.json().catch(() => ({}));
  console.log(`sign-in with the secret ${label}: ${r.ok ? "OK (user " + j.user?.email + ")" : "FAILED HTTP " + r.status + " " + (j.error_description || j.msg || j.error || "")}`);
}
console.log("auth user row:", sql(`select email || ' confirmed=' || (email_confirmed_at is not null) || ' banned=' || coalesce(banned_until::text,'no') || ' providers=' || coalesce(raw_app_meta_data->>'providers','?') from auth.users where email='${EMAIL}'`));
