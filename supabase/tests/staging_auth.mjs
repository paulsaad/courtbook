// Real Supabase Auth on STAGING: the behaviour account closing relies on (PR #18 review, finding 4).
// Auth API only — no migration, no public-table writes of our own. Throwaway users auth-*@courtbook.test are
// created with the admin API (no email is ever sent: sign-in codes come from admin.generateLink) and removed
// before and after. Refuses to run against anything but the expected staging project.
//
// What it establishes, each against the real service:
//   A. the access token carries amr [{method, timestamp}] (what recently_authenticated() reads), and the
//      timestamp is the SIGN-IN time: unchanged by a token refresh, renewed by a fresh code (the reauth step)
//   B. global sign-out (website signOut(), app signOut({scope:'global'})) ends every session's refresh
//   C. ban (pipeline step B, ban_duration 876000h): no new sign-in by password or code, no refresh; what an
//      access token issued before the ban can still do until it expires (why the database lock-out exists)
//   D. delete (pipeline step D): sign-in gone; a second delete and a ban of a deleted user answer exactly
//      404 user_not_found (the only answer pipeline.ts treats as "already gone"); a code cannot be issued
//   E. the same email registered again is a NEW account id (nothing of the old one comes back)
//   F. access-token lifetime (how long a stolen token outlives a closure)
//
// Env: STAGING_SUPABASE_URL, STAGING_ANON_KEY, STAGING_SERVICE_ROLE_KEY, DB (pooler URL), EXPECTED_REF, LIVE_REF.
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const { STAGING_SUPABASE_URL: RAW_URL, STAGING_ANON_KEY: ANON, STAGING_SERVICE_ROLE_KEY: SERVICE, DB, EXPECTED_REF, LIVE_REF } = process.env;
for (const [k, v] of Object.entries({ RAW_URL, ANON, SERVICE, DB, EXPECTED_REF, LIVE_REF })) if (!v) { console.log(`missing ${k}`); process.exit(1); }
const URL_ = new URL(RAW_URL.trim()).origin;
const results = [];
const record = (id, name, pass, detail = "") => {
  results.push({ id, name, pass });
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${id} ${name}${detail ? ` — ${detail}` : ""}`);
};
const note = (id, name, detail) => console.log(`  info  ${id} ${name} — ${detail}`);
const sql = (q) => execFileSync("psql", [DB, "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const PW = `T-${randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const amrTs = (jwt) => Math.max(...(claims(jwt).amr ?? []).map((a) => (typeof a.timestamp === "number" ? a.timestamp : -1)));
const errOf = (e) => (e ? `${e.status ?? "?"} ${e.code ?? "-"} ${String(e.message ?? "").slice(0, 60)}` : "none");

// ---------------------------------------------------------------- C. credentials (no write before these pass)
console.log("--- 0. every credential belongs to the staging project");
const host = new URL(URL_).host;
record("00", "API URL is the staging project", host === `${EXPECTED_REF}.supabase.co`, host);
record("01", "no credential mentions the live project", ![RAW_URL, ANON, SERVICE, DB].some((v) => v.includes(LIVE_REF)));
if (results.some((r) => !r.pass)) { console.log("credential checks failed: stopping before any write"); process.exit(1); }
const admin = createClient(URL_, SERVICE, opts);
const client = () => createClient(URL_, ANON, opts); // a separate "device" each time

const MINE = "email like 'auth-%@courtbook.test'";
const cleanup = () => sql(`delete from auth.users where ${MINE}`);
cleanup();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { cleanup(); } finally { process.exit(130); } });

async function makeUser(tag) {
  const email = `auth-${tag}-${Date.now()}@courtbook.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`createUser: ${errOf(error)}`);
  return { email, id: data.user.id };
}
const passwordSignIn = async (email) => { const c = client(); const r = await c.auth.signInWithPassword({ email, password: PW }); return { c, ...r }; };
/** The emailed sign-in code, issued without sending an email; then entered on a device, as the app does. */
async function codeSignIn(email) {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) return { error: link.error, stage: "issue" };
  const c = client();
  const r = await c.auth.verifyOtp({ email, token: link.data.properties.email_otp, type: "email" });
  return { c, ...r, stage: "verify" };
}

try {
  // ---------------------------------------------------------------- A. sign-in time in the token
  console.log("--- A. the sign-in time in the token (recently_authenticated)");
  const U = await makeUser("a");
  const t0 = Math.floor(Date.now() / 1000);
  const p = await passwordSignIn(U.email);
  record("A1", "password sign-in works", !p.error && !!p.data.session, errOf(p.error));
  const at1 = p.data.session.access_token;
  const c1 = claims(at1);
  record("A2", "token carries amr with a numeric sign-in timestamp", Array.isArray(c1.amr) && c1.amr.some((a) => typeof a.timestamp === "number"),
    JSON.stringify((c1.amr ?? []).map((a) => a.method)));
  record("A3", "amr timestamp is the sign-in time (within 60 s)", Math.abs(amrTs(at1) - t0) <= 60, `${amrTs(at1) - t0} s`);
  record("A4", "token's sub is the user and role is authenticated", c1.sub === U.id && c1.role === "authenticated");
  await sleep(3000);
  const ref1 = await p.c.auth.refreshSession();
  const at2 = ref1.data.session?.access_token;
  record("A5", "refresh issues a new access token", !ref1.error && !!at2 && at2 !== at1, errOf(ref1.error));
  record("A6", "refresh KEEPS the original sign-in time (a refreshed session is not a recent sign-in)", at2 && amrTs(at2) === amrTs(at1),
    at2 ? `before ${amrTs(at1)}, after ${amrTs(at2)}, iat ${claims(at2).iat}` : "");
  await sleep(2000);
  const code = await codeSignIn(U.email);
  record("A7", "an emailed code (issued by admin, no email sent) signs in", !code.error && !!code.data?.session, `${code.stage}: ${errOf(code.error)}`);
  const at3 = code.data?.session?.access_token;
  record("A8", "the code sign-in has a NEW sign-in time (the reauth step works)", !!at3 && amrTs(at3) > amrTs(at1),
    at3 ? `methods ${JSON.stringify(claims(at3).amr.map((a) => a.method))}, +${amrTs(at3) - amrTs(at1)} s` : "");
  const lifetime = c1.exp - c1.iat;
  note("F1", "access-token lifetime (exp − iat)", `${lifetime} s (${Math.round(lifetime / 60)} min)`);
  record("F2", "access tokens live at most 1 hour (a token outlives a closure by at most this)", lifetime <= 3600, `${lifetime} s`);

  // ---------------------------------------------------------------- B. global sign-out
  console.log("--- B. global sign-out ends every session");
  const dev1 = await passwordSignIn(U.email), dev2 = await passwordSignIn(U.email);
  record("B1", "two devices signed in", !dev1.error && !dev2.error);
  const so = await dev1.c.auth.signOut({ scope: "global" });
  record("B2", "global sign-out from device 1 succeeds", !so.error, errOf(so.error));
  const r2 = await dev2.c.auth.refreshSession();
  record("B3", "device 2 can no longer refresh", !!r2.error && !r2.data.session, errOf(r2.error));
  const r3 = await code.c.auth.refreshSession();
  record("B4", "the code-signed-in session can no longer refresh either", !!r3.error && !r3.data.session, errOf(r3.error));
  const live = sql(`select count(*) from auth.sessions where user_id = '${U.id}'`);
  record("B5", "no Auth sessions left for the user", live === "0", `${live} left`);

  // ---------------------------------------------------------------- C. ban
  console.log("--- C. ban (pipeline step B)");
  const before = await passwordSignIn(U.email); // a session that exists when the account is closed
  const tokenBefore = before.data.session.access_token;
  const ban = await admin.auth.admin.updateUserById(U.id, { ban_duration: "876000h" });
  record("C1", "ban with ban_duration 876000h succeeds", !ban.error, errOf(ban.error));
  const bu = sql(`select banned_until > now() + interval '50 years' from auth.users where id = '${U.id}'`);
  record("C2", "banned_until is decades away", bu === "t", bu);
  const pb = await passwordSignIn(U.email);
  record("C3", "banned: password sign-in refused", !!pb.error && !pb.data.session, errOf(pb.error));
  const cb = await codeSignIn(U.email);
  record("C4", "banned: sign-in by code refused", !!cb.error && !cb.data?.session, `${cb.stage}: ${errOf(cb.error)}`);
  const rb = await before.c.auth.refreshSession();
  record("C5", "banned: an existing session cannot refresh", !!rb.error && !rb.data.session, errOf(rb.error));
  const gu = await admin.auth.getUser(tokenBefore);
  note("C6", "Auth's getUser with a token issued before the ban", gu.error ? `refused: ${errOf(gu.error)}` : "still answers the user");
  const rest = await fetch(`${URL_}/rest/v1/profiles?select=id&id=eq.${U.id}`, { headers: { apikey: ANON, Authorization: `Bearer ${tokenBefore}` } });
  note("C7", "database API with a token issued before the ban", `HTTP ${rest.status} — the token stays valid until it expires (≤ F1); 0086's lock-out trigger is what refuses it`);
  const soBanned = await admin.auth.admin.signOut(tokenBefore, "global");
  note("C9", "admin global sign-out with the pre-ban token", soBanned.error ? errOf(soBanned.error) : "ok");

  // ---------------------------------------------------------------- D. delete
  console.log("--- D. delete (pipeline step D)");
  const del = await admin.auth.admin.deleteUser(U.id);
  record("D1", "delete succeeds", !del.error, errOf(del.error));
  record("D2", "user row gone; no sessions or refresh tokens left",
    sql(`select (select count(*) from auth.users where id='${U.id}') + (select count(*) from auth.sessions where user_id='${U.id}') + (select count(*) from auth.refresh_tokens where user_id='${U.id}')`) === "0");
  const del2 = await admin.auth.admin.deleteUser(U.id);
  record("D3", "deleting again answers 404 user_not_found (pipeline treats only this as 'already gone')",
    del2.error?.status === 404 && del2.error?.code === "user_not_found", errOf(del2.error));
  const ban2 = await admin.auth.admin.updateUserById(U.id, { ban_duration: "876000h" });
  record("D4", "banning a deleted user answers 404 user_not_found (a retry after D is safe)",
    ban2.error?.status === 404 && ban2.error?.code === "user_not_found", errOf(ban2.error));
  const pd = await passwordSignIn(U.email);
  record("D5", "deleted: password sign-in refused", !!pd.error && !pd.data.session, errOf(pd.error));
  const cd = await codeSignIn(U.email);
  record("D6", "deleted: no sign-in code can be used (the app asks with shouldCreateUser:false)", !!cd.error && !cd.data?.session, `${cd.stage}: ${errOf(cd.error)}`);
  const gd = await admin.auth.getUser(tokenBefore);
  record("D7", "deleted: Auth refuses the old token", !!gd.error, errOf(gd.error));
  const leftover = sql(`select count(*) from auth.users where email = '${U.email}'`);
  record("D8", "the code attempt did not recreate the account", leftover === "0", `${leftover} rows`);

  // ---------------------------------------------------------------- E. same email again
  console.log("--- E. the same email registered again");
  const again = await admin.auth.admin.createUser({ email: U.email, password: PW, email_confirm: true });
  record("E1", "the email can register again", !again.error, errOf(again.error));
  record("E2", "…as a NEW account id", !!again.data?.user && again.data.user.id !== U.id);
  const prof = sql(`select count(*) from profiles where id = '${U.id}'`);
  record("E3", "nothing under the old id", prof === "0", `${prof} profile rows`);
} catch (e) {
  record("X", "unexpected error", false, String(e?.message ?? e).slice(0, 200));
} finally {
  cleanup();
  const left = sql(`select count(*) from auth.users where ${MINE}`);
  record("Z", "throwaway users removed", left === "0", `${left} left`);
}
const failed = results.filter((r) => !r.pass);
console.log(`summary: ${results.length - failed.length} ok, ${failed.length} FAIL`);
console.log(failed.length ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed.length ? 1 : 0);
