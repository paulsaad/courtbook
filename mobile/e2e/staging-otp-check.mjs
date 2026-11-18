// Read-only-for-real-users check of staging's email-code sign-in (branch staging-otp-check only).
// Uses DISPOSABLE @courtbook.test accounts and the admin generate_link call, which returns the same
// one-time code an email would carry but SENDS NO EMAIL. Prints only lengths and pass/fail: never a
// code, token, password or a real email address. Disposable accounts are deleted at the end.
import { execFileSync } from "node:child_process";
const STAGING_REF = "pwznauyioqykdwodwpvx", LIVE_REF = "lgujfbwunokobjxlvpuf";
const { STAGING_SUPABASE_URL: URL_, STAGING_SERVICE_ROLE_KEY: SERVICE, STAGING_DB_URL: DB, STAGING_ANON_KEY: ANON } = process.env;
for (const [k, v] of Object.entries({ STAGING_SUPABASE_URL: URL_, STAGING_SERVICE_ROLE_KEY: SERVICE, STAGING_DB_URL: DB, STAGING_ANON_KEY: ANON }))
  if (!v) { console.error(`::error::${k} is not set`); process.exit(1); }
if (new URL(URL_.trim()).host !== `${STAGING_REF}.supabase.co` || !DB.includes(STAGING_REF) || (URL_ + DB).includes(LIVE_REF)) {
  console.error("::error::Refusing: these settings are not the staging project."); process.exit(1);
}
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-At", "-c", q], { encoding: "utf8" }).trim();
const AUTH = URL_.trim().replace(/\/$/, "") + "/auth/v1";
const admin = { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" };
const pub = { apikey: ANON, "content-type": "application/json" };
const tag = Date.now().toString(36);
const made = [];
const ok = (label, cond, detail = "") => console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? "  [" + detail + "]" : ""}`);

// 0. read-only: real (non-test) accounts created on staging in the last day — counts and times only
console.log("real accounts created in the last 24 h: " + (sql(`select count(*) || ' (unconfirmed: ' || count(*) filter (where email_confirmed_at is null) || '; created ' || coalesce(string_agg(to_char(created_at at time zone 'UTC','HH24:MI') || ' UTC', ', '),'-') || '; confirmation email sent ' || coalesce(string_agg(to_char(confirmation_sent_at at time zone 'UTC','HH24:MI') || ' UTC', ', '),'-') || ')' from auth.users where created_at > now() - interval '1 day' and email not like '%@courtbook.test'`)));

async function makeUser(confirmed) {
  const email = `otp-check-${confirmed ? "confirmed" : "new"}-${tag}@courtbook.test`;
  const r = await fetch(`${AUTH}/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email, email_confirm: confirmed }) });
  const j = await r.json(); if (!r.ok) throw new Error(`create ${r.status} ${j.msg || j.message || ""}`);
  made.push(j.id); return email;
}
async function code(email) {   // the code an email would carry; no email is sent
  const r = await fetch(`${AUTH}/admin/generate_link`, { method: "POST", headers: admin, body: JSON.stringify({ type: "magiclink", email }) });
  const j = await r.json(); if (!r.ok) throw new Error(`generate_link ${r.status} ${j.msg || j.message || ""}`);
  return j.email_otp ?? j.properties?.email_otp;
}
async function verify(email, token) {   // exactly the app's call: verifyOtp({ email, token, type: "email" })
  const r = await fetch(`${AUTH}/verify`, { method: "POST", headers: pub, body: JSON.stringify({ type: "email", email, token }) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && !!j.access_token, status: r.status, msg: j.msg || j.error_description || j.message || "" };
}
try {
  for (const confirmed of [false, true]) {
    const who = confirmed ? "existing confirmed account" : "new, unconfirmed account (like Paul's)";
    const email = await makeUser(confirmed);
    const c = await code(email);
    ok(`${who}: staging generates a code of 6 digits (the app accepts at most 6)`, /^\d{6}$/.test(c || ""), `length ${c ? c.length : "none"}, digits only: ${/^\d+$/.test(c || "")}`);
    const bad = await verify(email, c && c[0] === "0" ? "1" + c.slice(1) : "0" + (c || "").slice(1));
    ok(`${who}: a wrong code is refused`, !bad.ok, `HTTP ${bad.status} ${bad.msg}`);
    const good = await verify(email, c);
    ok(`${who}: the right code signs in with type "email" (the app's call)`, good.ok, `HTTP ${good.status} ${good.msg}`);
    const state = sql(`select (email_confirmed_at is not null) || '/' || (last_sign_in_at is not null) from auth.users where email='${email}'`);
    ok(`${who}: afterwards the account is confirmed and has signed in`, state === "true/true", state);
  }
} catch (e) { console.log(`FAIL check aborted: ${e.message}`); }
finally {
  for (const id of made) await fetch(`${AUTH}/admin/users/${id}`, { method: "DELETE", headers: admin });
  console.log(`disposable accounts removed: ${sql(`select count(*) = 0 from auth.users where email like 'otp-check-%-${tag}@courtbook.test'`)}`);
}
