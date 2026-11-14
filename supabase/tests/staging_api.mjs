// Staging checks through Supabase's own API (PostgREST + Auth), the way the website and the app
// actually call the database, plus the web payment route with app (bearer) and website (cookie)
// sign-ins. Throwaway players api-*@courtbook.test are created and removed; the demo club's payment
// mode is restored. Refuses to run against anything but the expected staging project.
//
// Env: STAGING_SUPABASE_URL, STAGING_ANON_KEY, STAGING_SERVICE_ROLE_KEY, DB (pooler URL),
//      EXPECTED_REF, LIVE_REF, APP_URL (the web app built from this branch, pointed at staging).
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const { STAGING_SUPABASE_URL: RAW_URL, STAGING_ANON_KEY: ANON, STAGING_SERVICE_ROLE_KEY: SERVICE, DB, EXPECTED_REF, LIVE_REF, APP_URL } = process.env;
const URL_ = new URL(RAW_URL.trim()).origin;
const results = [];
const record = (id, name, pass, detail = "") => {
  results.push({ id, name, pass, detail });
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${id} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sql = (q) => execFileSync("psql", [DB, "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
const opts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const PW = `T-${randomUUID()}`;

function keyInfo(key) {
  if (key.startsWith("eyJ")) {
    const p = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString());
    return { kind: "jwt", ref: p.ref, role: p.role };
  }
  return { kind: key.startsWith("sb_publishable_") ? "publishable" : key.startsWith("sb_secret_") ? "secret" : "unknown" };
}

// ---------------------------------------------------------------- C. credentials
console.log("--- C. every credential belongs to the staging project");
const host = new URL(URL_).host;
const urlRef = host.split(".")[0];
record("C1", "API URL is the staging project", urlRef === EXPECTED_REF && host === `${EXPECTED_REF}.supabase.co`, host);
record("C2", "no credential mentions the live project", ![RAW_URL, ANON, SERVICE, DB].some((v) => v.includes(LIVE_REF)));
const ai = keyInfo(ANON), si = keyInfo(SERVICE);
record("C3", "anon key is an anon key for staging", ai.kind === "publishable" || (ai.kind === "jwt" && ai.ref === EXPECTED_REF && ai.role === "anon"), JSON.stringify(ai));
record("C4", "service key is a service key for staging", si.kind === "secret" || (si.kind === "jwt" && si.ref === EXPECTED_REF && si.role === "service_role"), JSON.stringify(si));
if (results.some((r) => !r.pass)) { console.log("credential checks failed: stopping before any write"); process.exit(1); }
const admin = createClient(URL_, SERVICE, opts);
const anon = createClient(URL_, ANON, opts);
{ const r = await fetch(`${URL_}/rest/v1/clubs?select=id&limit=1`, { headers: { apikey: ANON } });
  record("C5", "staging accepts the anon key", r.status === 200, `HTTP ${r.status}`); }
const ADMIN_LIST = await admin.auth.admin.listUsers({ page: 1, perPage: 1 });
record("C6", "staging accepts the service key (admin API)", !ADMIN_LIST.error, ADMIN_LIST.error?.message ?? "");
if (results.some((r) => !r.pass)) process.exit(1);

// ---------------------------------------------------------------- setup
const CLUB = sql("select id from clubs where slug='batroun'");
const COURT = sql(`select id from courts where club_id='${CLUB}' and name='Padel 1'`);
const COURT2 = sql(`select id from courts where club_id='${CLUB}' and name='Padel 2'`);
const COURT3 = sql(`select id from courts where club_id='${CLUB}' and name='Padel 3'`);
const MODE = sql(`select payment_mode from clubs where id='${CLUB}'`);
const day = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);
const at = (hhmm) => new Date(`${day}T${hhmm}:00+02:00`).toISOString(); // Beirut is UTC+2 in November

function cleanup() {
  sql(`delete from payments where booking_id in (select b.id from bookings b join auth.users u on u.id = b.player_id where u.email like 'api-%@courtbook.test');
       delete from bookings where player_id in (select id from auth.users where email like 'api-%@courtbook.test');
       delete from auth.users where email like 'api-%@courtbook.test';
       update clubs set payment_mode='${MODE}' where id='${CLUB}';`);
}
cleanup();

async function player(n) {
  const email = `api-${n}-${Date.now()}@courtbook.test`;
  const { error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`createUser: ${error.message}`);
  const client = createClient(URL_, ANON, opts);
  const { data, error: e2 } = await client.auth.signInWithPassword({ email, password: PW });
  if (e2) throw new Error(`signIn: ${e2.message}`);
  return { client, email, token: data.session.access_token, id: data.user.id };
}

let exitCode = 0;
try {
  const U1 = await player(1), U2 = await player(2);
  record("C7", "the API and the database are the same project (a user made through the API is in the database)",
    sql(`select count(*) from auth.users where id in ('${U1.id}','${U2.id}')`) === "2");

  const errOf = (r) => r.error ? (r.error.message ?? String(r.error)) : null;
  const rowOf = (r) => (Array.isArray(r.data) ? r.data[0] : r.data);

  // ---------------------------------------------------------------- A. pay at the club, over HTTP
  console.log("--- A. book_at_desk through the API (the app's path for pay-at-the-club clubs)");
  sql(`update clubs set payment_mode='at_desk' where id='${CLUB}'`);
  const desk = (u, court, s, e, token) => u.client.rpc("book_at_desk", { p_court: court, p_start: at(s), p_end: at(e), p_token: token });
  const T1 = randomUUID(), T2 = randomUUID();
  const [a1, a2] = await Promise.all([desk(U1, COURT, "10:00", "11:30", T1), desk(U2, COURT, "10:00", "11:30", T2)]);
  const okA = [a1, a2].filter((r) => !r.error), badA = [a1, a2].filter((r) => r.error);
  record("A1", "two players, same court and time, at the same moment: one booking, the other slot_taken",
    okA.length === 1 && badA.length === 1 && errOf(badA[0]).includes("slot_taken"), `${okA.length} ok, ${badA.map(errOf).join(",")}`);
  const winner = okA[0] === a1 ? { u: U1, t: T1 } : { u: U2, t: T2 };
  const loser = winner.u === U1 ? U2 : U1;
  const B = rowOf(okA[0]).booking_id;
  const a3 = await desk(winner.u, COURT, "10:00", "11:30", winner.t);
  record("A2", "a retry with the same token returns the same booking, marked as a replay", rowOf(a3)?.booking_id === B && rowOf(a3)?.already === true);
  const burst = await Promise.all([1, 2, 3].map(() => desk(winner.u, COURT, "10:00", "11:30", winner.t)));
  record("A3", "three simultaneous retries with that token: all get the same booking, one row exists",
    burst.every((r) => rowOf(r)?.booking_id === B) && sql(`select count(*) from bookings where client_token='${winner.t}'`) === "1");
  const a4 = await desk(winner.u, COURT, "14:00", "15:00", winner.t);
  record("A4", "same token, different time: refused", errOf(a4)?.includes("token_reused"), errOf(a4) ?? "no error");
  const own = await winner.u.client.from("bookings").select("id, status").eq("client_token", winner.t);
  record("A5", "the player finds the booking by its token (the app's check after a lost reply)", own.data?.length === 1 && own.data[0].id === B);
  const theirs = await loser.client.from("bookings").select("id").eq("client_token", winner.t);
  record("A6", "another player finds nothing with that token", theirs.data?.length === 0, errOf(theirs) ?? "");
  record("A7", "price stored is the server's (1 h 30 off-peak at $20/h)", sql(`select price_usd from bookings where id='${B}'`) === "30.00");

  // ---------------------------------------------------------------- R. other players' bookings
  console.log("--- R. row-level security: nobody reads or changes another player's booking");
  const r1 = await loser.client.from("bookings").select("id").eq("id", B);
  record("R1", "read another player's booking by id: nothing", r1.data?.length === 0, errOf(r1) ?? "");
  const r2 = await loser.client.from("bookings").update({ status: "cancelled" }).eq("id", B).select("id");
  record("R2", "update another player's booking: refused or no rows", (r2.error || r2.data?.length === 0) && sql(`select status from bookings where id='${B}'`) === "confirmed", errOf(r2) ?? "0 rows");
  const r3 = await loser.client.from("bookings").delete().eq("id", B).select("id");
  record("R3", "delete another player's booking: refused or no rows", (r3.error || r3.data?.length === 0) && sql(`select count(*) from bookings where id='${B}'`) === "1", errOf(r3) ?? "0 rows");
  const r4 = await loser.client.rpc("cancel_booking", { p_booking: B, p_club_caused: false });
  record("R4", "cancel another player's booking: forbidden", errOf(r4)?.includes("forbidden"), errOf(r4) ?? "no error");
  const r5 = await loser.client.from("bookings").insert({ club_id: CLUB, court_id: COURT2, player_id: winner.u.id, start_at: at("16:00"), end_at: at("17:00"), status: "confirmed" }).select("id");
  record("R5", "write a booking directly (bypassing the functions): refused", !!r5.error, errOf(r5) ?? "inserted!");
  const r6 = await winner.u.client.from("bookings").update({ price_usd: 0 }).eq("id", B).select("id");
  record("R6", "even the owner cannot edit their booking directly (price)", (r6.error || r6.data?.length === 0) && sql(`select price_usd from bookings where id='${B}'`) === "30.00", errOf(r6) ?? "0 rows");
  const r7 = await loser.client.rpc("my_agenda");
  record("R7", "another player's agenda does not include it", !r7.error && !(r7.data ?? []).some((x) => x.id === B));
  const r8 = await anon.from("bookings").select("id").eq("id", B);
  record("R8", "a visitor (not signed in) reads nothing", (r8.error || r8.data?.length === 0), errOf(r8) ?? "0 rows");
  const r9 = await anon.rpc("book_at_desk", { p_court: COURT2, p_start: at("18:00"), p_end: at("19:00"), p_token: randomUUID() });
  record("R9", "a visitor cannot book", !!r9.error, errOf(r9) ?? "booked!");
  const r10 = await winner.u.client.rpc("cancel_booking", { p_booking: B, p_club_caused: false });
  record("R10", "the owner can cancel", !r10.error && sql(`select status from bookings where id='${B}'`) === "cancelled", errOf(r10) ?? "");
  const r11 = await winner.u.client.rpc("cancel_booking", { p_booking: B, p_club_caused: false });
  record("R11", "cancelling again: not_confirmed (the app re-reads the booking on this)", errOf(r11)?.includes("not_confirmed"), errOf(r11) ?? "no error");

  // ---------------------------------------------------------------- B. hold_slot after 0065
  console.log("--- B. hold_slot through the API after 0065 (website and app)");
  sql(`update clubs set payment_mode='simulated' where id='${CLUB}'`);
  const web = (u, court, s, e) => u.client.rpc("hold_slot", { p_club: CLUB, p_court: court, p_start: at(s), p_end: at(e) }); // exactly what src/lib/reserve.ts sends
  const app = (u, court, s, e, token) => u.client.rpc("hold_slot", { p_club: CLUB, p_court: court, p_start: at(s), p_end: at(e), p_token: token });
  const b0 = await web(U2, COURT3, "09:00", "10:00");
  record("B1", "the website's call (4 named arguments) works: no 'could not choose' ambiguity", !b0.error && !!rowOf(b0)?.booking_id, errOf(b0) ?? `status ${b0.status}`);
  const b0b = await web(U2, COURT3, "12:00", "13:00");
  record("B2", "a second website hold replaces the first, as before",
    !b0b.error && sql(`select status from bookings where id='${rowOf(b0).booking_id}'`) === "expired" && sql(`select status from bookings where id='${rowOf(b0b).booking_id}'`) === "pending");
  record("B3", "website holds carry no token", sql(`select count(*) from bookings where id in ('${rowOf(b0).booking_id}','${rowOf(b0b).booking_id}') and client_token is not null`) === "0");
  const T3 = randomUUID();
  const h1 = await app(U1, COURT2, "18:00", "19:00", T3);
  const h2 = await app(U1, COURT2, "18:00", "19:00", T3);
  record("B4", "the app's call with a token: new, then the retry returns the same hold marked as a replay",
    rowOf(h1)?.already === false && rowOf(h2)?.booking_id === rowOf(h1)?.booking_id && rowOf(h2)?.already === true, errOf(h1) ?? errOf(h2) ?? "");
  record("B5", "one pending booking and one pending payment for that token",
    sql(`select count(*)||'/'||max(b.status::text)||'/'||max(p.status::text) from bookings b join payments p on p.booking_id=b.id where b.client_token='${T3}'`) === "1/pending/pending");
  const T4 = randomUUID();
  const hb = await Promise.all([1, 2, 3].map(() => app(U1, COURT2, "20:00", "21:00", T4)));
  const ids = new Set(hb.map((r) => rowOf(r)?.booking_id));
  record("B6", "three simultaneous app calls with one token: one booking", ids.size === 1 && !ids.has(undefined) && sql(`select count(*) from bookings where client_token='${T4}'`) === "1", hb.map((r) => errOf(r) ?? "ok").join(","));
  const h3 = await app(U1, COURT3, "20:00", "21:00", T4);
  record("B7", "same token, different court: refused", errOf(h3)?.includes("token_reused"), errOf(h3) ?? "no error");
  const [c1, c2] = await Promise.all([app(U1, COURT, "15:00", "16:00", randomUUID()), app(U2, COURT, "15:00", "16:00", randomUUID())]);
  const okB = [c1, c2].filter((r) => !r.error);
  record("B8", "two players hold the same slot at the same moment: one hold, the other slot_taken",
    okB.length === 1 && [c1, c2].some((r) => errOf(r)?.includes("slot_taken")), [c1, c2].map((r) => errOf(r) ?? "ok").join(","));
  const holder = okB[0] === c1 ? U1 : U2, other = holder === U1 ? U2 : U1;
  const hold = rowOf(okB[0]);
  const p1 = await other.client.from("payments").select("id").eq("id", hold.payment_id);
  record("R12", "another player cannot read that player's payment", p1.data?.length === 0, errOf(p1) ?? "");
  const p2 = await other.client.from("payments").update({ status: "paid" }).eq("id", hold.payment_id).select("id");
  record("R13", "nor mark it paid", (p2.error || p2.data?.length === 0) && sql(`select status from payments where id='${hold.payment_id}'`) === "pending", errOf(p2) ?? "0 rows");
  const p3 = await holder.client.rpc("confirm_payment", { p_payment: hold.payment_id, p_provider_ref: "x", p_total_usd: 21 });
  record("R14", "the owner cannot confirm their own payment directly (server only)", !!p3.error && sql(`select status from payments where id='${hold.payment_id}'`) === "pending", errOf(p3) ?? "confirmed!");

  // ---------------------------------------------------------------- P. the web payment route
  console.log(`--- P. /api/pay/simulate and /api/notify/email (this branch's web app at ${APP_URL}, pointed at staging)`);
  const pay = (body, headers = {}) => fetch(`${APP_URL}/api/pay/simulate`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  const PAY = hold.payment_id;
  const status = () => sql(`select p.status||'/'||b.status from payments p join bookings b on b.id=p.booking_id where p.id='${PAY}'`);
  let r = await pay({ paymentId: PAY });
  record("P1", "no sign-in at all: 401", r.status === 401, `HTTP ${r.status} ${await r.text()}`);
  r = await pay({ paymentId: PAY }, { authorization: "Bearer not-a-token" });
  record("P2", "malformed bearer token: 401", r.status === 401, `HTTP ${r.status}`);
  r = await pay({ paymentId: PAY }, { authorization: `Basic ${Buffer.from("a:b").toString("base64")}` });
  record("P3", "'Basic' credentials: 401", r.status === 401, `HTTP ${r.status}`);
  const [h, , sig] = holder.token.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: holder.id, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.${sig}`;
  r = await pay({ paymentId: PAY }, bearer(forged));
  record("P4", "a token that decodes but is not signed by staging (owner's id inside): 401", r.status === 401, `HTTP ${r.status}`);
  r = await pay({ paymentId: PAY }, bearer(other.token));
  record("P5", "another player's real token for this payment: 404, nothing changes", r.status === 404 && status() === "pending/pending", `HTTP ${r.status}, ${status()}`);
  r = await pay({ paymentId: PAY, user_id: holder.id, profile_id: holder.id, userId: holder.id }, bearer(other.token));
  record("P6", "...even with the owner's id in the body: 404 (identity is never read from the body)", r.status === 404 && status() === "pending/pending", `HTTP ${r.status}`);
  const U3 = await player(3);
  await admin.auth.admin.deleteUser(U3.id);
  r = await pay({ paymentId: PAY }, bearer(U3.token));
  record("P7", "the token of a deleted account: 401", r.status === 401, `HTTP ${r.status}`);
  r = await pay({ paymentId: PAY }, bearer(holder.token));
  const body7 = await r.text();
  record("P8", "the owner's app token: paid, booking confirmed", r.status === 200 && status() === "paid/confirmed", `HTTP ${r.status} ${body7}, ${status()}`);
  r = await pay({ paymentId: PAY }, bearer(holder.token));
  record("P9", "paying again: 409 not_payable, still one payment", r.status === 409 && status() === "paid/confirmed", `HTTP ${r.status}`);

  // the website: cookie session made by the same library the web app uses
  const jar = new Map();
  const ssr = createServerClient(URL_, ANON, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)) } });
  const s1 = await ssr.auth.signInWithPassword({ email: other.email, password: PW });
  const cookie = [...jar].map(([n, v]) => `${n}=${v}`).join("; ");
  const wh = await web(other, COURT3, "21:00", "22:00");
  const WPAY = rowOf(wh)?.payment_id;
  r = await pay({ paymentId: WPAY }, { cookie, authorization: "Bearer not-a-token" });
  record("P10", "website cookie plus a bad Authorization header: 401 (never falls back to the cookie)", r.status === 401, `HTTP ${r.status}`);
  r = await pay({ paymentId: WPAY }, { cookie });
  record("P11", "the website's cookie sign-in, unchanged: paid", !s1.error && r.status === 200 && sql(`select status from payments where id='${WPAY}'`) === "paid", `HTTP ${r.status} ${await r.text()}`);
  const n1 = await fetch(`${APP_URL}/api/notify/email`, { method: "POST", headers: bearer(holder.token) });
  const n2 = await fetch(`${APP_URL}/api/notify/email`, { method: "POST", headers: { authorization: "Bearer x.y.z" } });
  record("P12", "/api/notify/email: app token accepted, invalid token 401", n1.status === 200 && n2.status === 401, `${n1.status} / ${n2.status}`);
} catch (e) {
  record("X", "test run stopped", false, e.message);
} finally {
  cleanup();
  const left = sql("select count(*) from auth.users where email like 'api-%@courtbook.test'");
  record("Z1", "clean-up: no test players, bookings or payments left; club mode restored", left === "0" && sql(`select payment_mode from clubs where id='${CLUB}'`) === MODE);
}
const failed = results.filter((r) => !r.pass);
console.log(`\nchecks: ${results.length}, failures: ${failed.length}`);
if (failed.length) { console.log("FAILED: " + failed.map((f) => f.id).join(", ")); exitCode = 1; } else console.log("STAGING API OK");
process.exit(exitCode);
