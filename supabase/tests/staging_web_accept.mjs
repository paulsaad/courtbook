// Website acceptance for launch-1 (0078–0084) on STAGING, in a real browser (puppeteer) against this branch's website built
// against staging (the `web_accept` action builds it on http://localhost:3100). Disposable fixtures only:
//   accounts web-*@courtbook.test (one is a temporary admin), a temporary court zz-web-1 in the demo club, a test club
//   zz-web-<time>, one test game with one message. Existing clubs, players, bookings and calendar blocks are never touched;
//   the demo club's payment mode is switched for the test and put back. Everything is removed at the end, on failure and
//   on cancellation; Z1 checks it. Neither feature switch is changed.
// Env: DB (staging connection string), STAGING_SUPABASE_URL, STAGING_ANON_KEY, STAGING_SERVICE_ROLE_KEY, EXPECTED_REF, APP_URL.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const DB = process.env.DB, URL_ = process.env.STAGING_SUPABASE_URL?.trim(), ANON = process.env.STAGING_ANON_KEY?.trim();
const SERVICE = process.env.STAGING_SERVICE_ROLE_KEY?.trim(), REF = process.env.EXPECTED_REF, APP = process.env.APP_URL ?? "http://localhost:3100";
if (!DB || !URL_ || !ANON || !SERVICE || !REF) { console.log("missing environment"); process.exit(2); }
if ([DB, URL_].some((v) => v.includes("lgujfbwunokobjxlvpuf"))) { console.log("refusing: LIVE project"); process.exit(2); }
if (new URL(URL_).host !== `${REF}.supabase.co`) { console.log("refusing: API URL is not the expected staging project"); process.exit(2); }
const puppeteer = createRequire("/tmp/tools/")("puppeteer");
const SHOTS = "/tmp/web-accept"; mkdirSync(SHOTS, { recursive: true });

const sql = (q) => execFileSync("psql", [DB, "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
const results = [];
const record = (id, what, pass, detail = "") => { results.push({ id, pass }); console.log(`  ${pass ? "ok  " : "FAIL"}  ${id} ${what}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`); };
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(URL_, SERVICE, opts);
const PW = `T-${randomUUID()}`;
const STAMP = Date.now().toString(36);

const CLUB = sql("select id from clubs where slug='batroun'");
const MODE = sql(`select payment_mode from clubs where id='${CLUB}'`);
const U = "(select id from auth.users where email like 'web-%@courtbook.test')";
const TESTCOURTS = `(select id from courts where club_id = '${CLUB}' and name like 'zz-web-%')`;
const TESTCLUBS = "(select id from clubs where slug like 'zz-web-%')";
function cleanup() {
  sql(`begin;
    alter table moderation_log disable trigger moderation_log_append_only;
    delete from moderation_log where admin_id in ${U} or profile_id in ${U} or report_id in (select id from reports where reporter_id in ${U} or profile_id in ${U});
    alter table moderation_log enable trigger moderation_log_append_only;
    delete from reports where reporter_id in ${U} or profile_id in ${U} or handled_by in ${U} or match_id in (select id from matches where organizer_id in ${U});
    delete from account_suspensions where profile_id in ${U} or suspended_by in ${U};
    delete from notifications where profile_id in ${U} or actor_id in ${U};
    delete from match_messages where profile_id in ${U} or match_id in (select id from matches where organizer_id in ${U});
    delete from match_players where profile_id in ${U} or match_id in (select id from matches where organizer_id in ${U});
    delete from matches where organizer_id in ${U};
    delete from payments where booking_id in (select id from bookings where court_id in ${TESTCOURTS} or player_id in ${U} or created_by in ${U});
    delete from bookings where court_id in ${TESTCOURTS} or player_id in ${U} or created_by in ${U};
    delete from courts where id in ${TESTCOURTS};
    delete from price_rules where club_id in ${TESTCLUBS};
    delete from courts where club_id in ${TESTCLUBS};
    delete from club_staff where profile_id in ${U} or club_id in ${TESTCLUBS};
    delete from clubs where id in ${TESTCLUBS};
    delete from account_deletions where subject_id in ${U} or processed_by in ${U} or summary::text like '%web-%@courtbook.test%';
    delete from auth.users where email like 'web-%@courtbook.test';
    update clubs set payment_mode = '${MODE}' where id = '${CLUB}';
    commit;`);
}
cleanup();
let browser;
const bye = () => { try { cleanup(); } finally { process.exit(130); } };
process.on("SIGINT", bye); process.on("SIGTERM", bye);

async function person(tag, name) {
  const email = `web-${tag}-${STAMP}@courtbook.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`createUser: ${error.message}`);
  const id = data.user.id;
  sql(`update profiles set name = '${name}' where id = '${id}'`);
  // signed in exactly as the website does it (@supabase/ssr), so the browser carries the site's own cookies
  const jar = [];
  const ssr = createServerClient(URL_, ANON, { cookies: { getAll: () => jar, setAll: (cs) => { for (const c of cs) { const i = jar.findIndex((x) => x.name === c.name); if (i >= 0) jar.splice(i, 1); jar.push({ name: c.name, value: c.value }); } } } });
  const s = await ssr.auth.signInWithPassword({ email, password: PW });
  if (s.error) throw new Error(`signIn: ${s.error.message}`);
  const api = createClient(URL_, ANON, opts);
  await api.auth.signInWithPassword({ email, password: PW });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setCookie(...jar.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/", sameSite: "Lax" })));
  return { id, email, name, api, page };
}
async function anonPage() { const ctx = await browser.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1280, height: 900 }); return p; }
const go = async (page, path) => { await page.goto(APP + path, { waitUntil: "networkidle0", timeout: 60000 }); return new URL(page.url()).pathname + new URL(page.url()).search; };
const text = (page) => page.evaluate(() => document.body.innerText);
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
// clicks the first visible button whose text is exactly `label` (inside `scope`, a CSS selector, if given)
async function click(page, label, scope = "body") {
  const ok = await page.evaluate((label, scope) => {
    const root = [...document.querySelectorAll(scope)].find(Boolean); if (!root) return false;
    const b = [...root.querySelectorAll("button")].find((x) => x.innerText.trim() === label && !x.disabled && x.offsetParent !== null);
    if (!b) return false; b.click(); return true;
  }, label, scope);
  if (!ok) throw new Error(`no enabled button "${label}" in ${scope}`);
}
const until = (page, fn, arg, ms = 20000) => page.waitForFunction(fn, { timeout: ms }, arg);
const hasText = (page, t, ms) => until(page, (t) => document.body.innerText.includes(t), t, ms).then(() => true, () => false);
const errOf = (r) => r.error ? (r.error.message ?? String(r.error)) : null;
const at = (days, hhmm) => sql(`select ((current_date + ${days} + time '${hhmm}') at time zone 'Asia/Beirut')`);

let exitCode = 0;
try {
  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  console.log(`--- setup (stamp ${STAMP}): accounts web-*-${STAMP}@courtbook.test, court zz-web-1, club zz-web-${STAMP}`);
  const A = await person("admin", "zz web admin"), P = await person("p18", "zz web player"), Q = await person("q17", "zz web under");
  const D = await person("del", "zz web delete"), T = await person("rep", "zz web reporter"), X = await person("x", "zz web reported");
  sql(`update profiles set roles = array_append(roles, 'admin') where id = '${A.id}'`);
  for (const who of [A, D, T, X]) sql(`update profiles set age_confirmed_at = now(), age_confirmed_via = 'web' where id = '${who.id}'`);
  sql(`insert into courts (club_id, name, sport, surface, sort) values ('${CLUB}', 'zz-web-1', 'padel', 'test', 931)`);
  const COURT = sql(`select id from courts where club_id='${CLUB}' and name='zz-web-1'`);
  record("S0", "switches untouched: both off", sql("select count(*) from app_settings where key in ('hide_demo_clubs','require_age_confirmation') and value = 'true'") === "0");

  // ------------------------------------------------------------------ V. who can see admin pages and data
  console.log("--- V. signed-out visitors and ordinary players cannot reach admin-only information");
  const anon = await anonPage();
  for (const path of ["/admin", "/admin/reports", "/admin/deletions"]) {
    const end = await go(anon, path);
    record(`V1${path}`, `signed out: ${path} → sign-in page`, end.startsWith("/login"), end);
  }
  for (const path of ["/admin", "/admin/reports", "/admin/deletions"]) {
    await go(P.page, path);
    const t = await text(P.page);
    record(`V2${path}`, `ordinary player: ${path} → "Admins only." and no admin data`, t.includes("Admins only.") && !t.includes("Account deletion requests") && !t.includes("Mark handled"), t.slice(0, 80));
  }
  { await go(P.page, "/staff/batroun/settings"); const t = await text(P.page); record("V3", "ordinary player: a club's settings → not staff", t.includes("You are not staff at"), t.slice(0, 80)); }
  const anonApi = createClient(URL_, ANON, opts);
  for (const [who, c] of [["signed out", anonApi], ["player", P.api]]) {
    const r1 = await c.rpc("admin_reports", { p_status: "open" });
    const r2 = await c.rpc("admin_account_deletions");
    const r3 = await c.from("moderation_log").select("id").limit(1);
    const r4 = await c.from("account_deletions").select("id").limit(1);
    const r5 = await c.from("reports").select("id").limit(1);
    record(`V4 ${who}`, `${who}: admin functions refused; moderation log, deletion requests and reports unreadable`,
      !!r1.error && !!r2.error && (!!r3.error || r3.data.length === 0) && (!!r4.error || r4.data.length === 0) && (!!r5.error || r5.data.length === 0),
      [errOf(r1), errOf(r2), errOf(r3) ?? r3.data?.length, errOf(r4) ?? r4.data?.length, errOf(r5) ?? r5.data?.length].join(" | "));
  }
  { const r = await fetch(`${APP}/api/admin/delete-account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject: D.id }) });
    record("V5", "signed out: the admin delete route refuses (401)", r.status === 401, r.status); }
  { const r = await P.page.evaluate(async (s) => (await fetch("/api/admin/delete-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject: s }) })).status, D.id);
    record("V6", "ordinary player: the admin delete route refuses (403) and nothing happens", r === 403 && sql(`select count(*) from auth.users where id='${D.id}'`) === "1", r); }

  // ------------------------------------------------------------------ G. 18+
  console.log("--- G. 18+ question (website)");
  { const end = await go(P.page, "/courts"); record("G1", "a new account opening Courts is sent to the 18+ question", end.startsWith("/age"), end);
    record("G2", "the question is shown", await hasText(P.page, "Are you 18 or over?"));
    await click(P.page, "Yes, I am 18 or over");
    await until(P.page, () => !location.pathname.startsWith("/age"));
    record("G3", "after Yes: back to Courts", new URL(P.page.url()).pathname === "/courts", P.page.url());
    const again = await go(P.page, "/courts"); record("G4", "never asked again", again.startsWith("/courts"), again);
    record("G5", "the answer is stored (web, with time)", sql(`select (age_confirmed_at is not null and age_confirmed_via = 'web')::text from profiles where id='${P.id}'`) === "true"); }
  { await go(Q.page, "/courts"); await hasText(Q.page, "Are you 18 or over?");
    await click(Q.page, "No, I am under 18");
    record("G6", "after No: told CourtBook is for 18+, with sign out", await hasText(Q.page, "CourtBook is for ages 18 and over"));
    const end = await go(Q.page, "/courts"); record("G7", "an account that said No is still sent to the question", end.startsWith("/age"), end);
    record("G8", "nothing stored for No", sql(`select (age_confirmed_at is null)::text from profiles where id='${Q.id}'`) === "true");
    const r = await Q.api.from("profiles").update({ age_confirmed_at: new Date().toISOString(), age_confirmed_via: "web" }).eq("id", Q.id).select("id");
    record("G9", "a player cannot mark themselves confirmed by writing the profile directly", sql(`select (age_confirmed_at is null)::text from profiles where id='${Q.id}'`) === "true", errOf(r) ?? `${r.data?.length} row(s)`); }

  // ------------------------------------------------------------------ D. account deletion
  console.log("--- D. account deletion: request, activity blocked, admin processing");
  sql(`update clubs set payment_mode = 'at_desk' where id = '${CLUB}'`);
  const b1 = await D.api.rpc("book_at_desk", { p_court: COURT, p_start: at(3, "10:00"), p_end: at(3, "11:00"), p_token: randomUUID() });
  const DB1 = (Array.isArray(b1.data) ? b1.data[0] : b1.data)?.booking_id;
  record("D0", "fixture: the account has a future booking", !!DB1, errOf(b1));
  { await go(D.page, "/profile"); await click(D.page, "Delete my account…"); await click(D.page, "Yes, delete my account");
    record("D1", "profile → Delete my account → Yes: request recorded, the page offers to keep the account", await hasText(D.page, "Keep my account (cancel the request)"));
    await shot(D.page, "d1-requested");
    record("D2", "stored as requested (web)", sql(`select status || '/' || requested_via from account_deletions where subject_id='${D.id}' and status = 'requested'`) === "requested/web"); }
  { const r = await D.api.rpc("book_at_desk", { p_court: COURT, p_start: at(3, "12:00"), p_end: at(3, "13:00"), p_token: randomUUID() });
    record("D3", "while deletion is pending: a new booking is refused", (errOf(r) ?? "").includes("account_deletion_requested"), errOf(r) ?? "booked!");
    record("D4", "...the existing booking is untouched until an admin processes it", sql(`select status from bookings where id='${DB1}'`) === "confirmed"); }
  { await go(A.page, "/admin/deletions");
    record("D5", "admin: the request is listed with its upcoming booking", await hasText(A.page, "zz web delete") && (await text(A.page)).includes("Upcoming bookings: 1"));
    await shot(A.page, "d5-board");
    // the row of this account only
    const clicked = await A.page.evaluate(() => {
      const row = [...document.querySelectorAll("li, article, div")].filter((e) => e.innerText.includes("zz web delete") && [...e.querySelectorAll("button")].some((b) => b.innerText.trim() === "Delete…")).sort((a, b) => a.innerText.length - b.innerText.length)[0];
      const b = row && [...row.querySelectorAll("button")].find((x) => x.innerText.trim() === "Delete…"); if (!b) return false; b.click(); return true; });
    if (!clicked) throw new Error("no Delete… button on the test account's row");
    await click(A.page, "Delete permanently");
    const gone = await until(A.page, () => !document.body.innerText.includes("zz web delete"), null, 30000).then(() => true, () => false);
    await shot(A.page, "d6-after");
    record("D6", "admin: Delete permanently → the request leaves the board", gone);
    record("D7", "the sign-in account is gone", sql(`select count(*) from auth.users where id='${D.id}'`) === "0");
    record("D8", "the request is done", sql(`select status from account_deletions where subject_id='${D.id}' order by requested_at desc limit 1`) === "done");
    record("D9", "the future booking is cancelled and no longer linked to the person", sql(`select status || '/' || coalesce(player_id::text, 'none') from bookings where id='${DB1}'`) === "cancelled/none"); }
  sql(`update clubs set payment_mode = '${MODE}' where id = '${CLUB}'`);

  // ------------------------------------------------------------------ C. new club: hidden until complete and published
  console.log("--- C. new club setup and publishing");
  const SLUG = `zz-web-${STAMP}`;
  { await go(A.page, "/admin"); await click(A.page, "Add a club");
    await A.page.type('input[placeholder="Club name"]', `ZZ Web Test ${STAMP}`);
    await A.page.type('input[placeholder^="url-name"]', SLUG);
    await click(A.page, "Create club");
    await until(A.page, () => !document.body.innerText.includes("Creating…"), null, 20000).catch(() => {});
    const row = sql(`select coalesce((select active::text from clubs where slug='${SLUG}'), 'missing')`);
    record("C1", "admin: Add a club → created, hidden (not published)", row === "false", row); }
  const NC = sql(`select id from clubs where slug='${SLUG}'`);
  { const r = await anonApi.from("clubs").select("id").eq("slug", SLUG);
    const d = await anonApi.rpc("club_discovery", {});
    const end = await go(anon, `/club/${SLUG}`); const t = await text(anon);
    record("C2", "signed out: the new club is not readable, not in discovery, its page shows nothing of it",
      (r.data ?? []).length === 0 && !(d.data ?? []).some((c) => c.slug === SLUG) && !t.includes(`ZZ Web Test ${STAMP}`), `${(r.data ?? []).length} row(s), page ${end}`); }
  { await go(A.page, `/staff/${SLUG}/settings`);
    const t = await text(A.page);
    record("C3", "settings: the readiness checklist is shown and lists what is missing", t.includes("Ready for players?") && /add at least one court|choose the town|add a phone number/.test(t), t.match(/Ready for players\?[\s\S]{0,200}/)?.[0]);
    const btn = await A.page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.includes("Publish"))?.disabled);
    record("C4", "Publish is not available while incomplete", btn === true, `disabled=${btn}`);
    const r = await A.api.from("clubs").update({ active: true }).eq("id", NC).select("id");
    record("C5", "even directly, the database refuses to publish an incomplete club", !!r.error && sql(`select active::text from clubs where id='${NC}'`) === "false", errOf(r) ?? "published!"); }
  // complete the checklist (the forms for courts, hours and prices are unchanged by launch-1; set as data here)
  sql(`update clubs set town_id = (select id from towns order by id limit 1), address = 'Test street', contact_phone = '+96170000000' where id = '${NC}';
       insert into courts (club_id, name, sport, surface, sort) values ('${NC}', 'Court 1', 'padel', 'test', 1);
       insert into price_rules (club_id, weekday_mask, start_time, end_time, price_usd) values ('${NC}', 127, '00:00', '23:59', 20);`);
  { await go(A.page, `/staff/${SLUG}/settings`);
    const ready = sql(`select bool_and(ok)::text from club_readiness_rows('${NC}')`);
    record("C6", "with everything filled in, the checklist is complete", ready === "true", sql(`select string_agg(item || ':' || ok, ' ') from club_readiness_rows('${NC}')`));
    await click(A.page, "Publish to players");
    const pub = await until(A.page, () => document.body.innerText.includes("Hide from players"), null, 20000).then(() => true, () => false);
    record("C7", "Publish to players → published", pub && sql(`select active::text from clubs where id='${NC}'`) === "true");
    const r = await anonApi.from("clubs").select("id").eq("slug", SLUG);
    await go(anon, `/club/${SLUG}`);
    record("C8", "signed out: the published club is readable and its page shows it", (r.data ?? []).length === 1 && (await text(anon)).includes(`ZZ Web Test ${STAMP}`)); }

  // ------------------------------------------------------------------ M. moderation
  console.log("--- M. reports, admin actions, legal hold, permissions");
  const MATCH = sql(`insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode) values ('${CLUB}', 'padel', '${X.id}', ${"(" + "(current_date + 5 + time '18:00') at time zone 'Asia/Beirut')"}, ${"(" + "(current_date + 5 + time '19:30') at time zone 'Asia/Beirut')"}, 3, 'open', 'open') returning id`).split("\n")[0];
  sql(`insert into match_players (match_id, profile_id, status) values ('${MATCH}', '${T.id}', 'accepted')`);
  const MSG = sql(`insert into match_messages (match_id, profile_id, body) values ('${MATCH}', '${X.id}', 'zz web test message ${STAMP}') returning id`).split("\n")[0];
  const rep = await T.api.rpc("report_content", { p_kind: "message", p_target: MSG, p_reason: "abuse", p_note: "web acceptance test" });
  record("M0", "fixture: a player reports a message in their game", !rep.error, errOf(rep));
  const REP = sql(`select id from reports where message_id='${MSG}'`);
  const inCard = async (fn, ...args) => A.page.evaluate((stamp, fnSrc, args) => {
    const art = [...document.querySelectorAll('article[aria-label^="Report"]')].find((a) => a.innerText.includes(stamp)); if (!art) return "no card";
    return new Function("art", "args", fnSrc)(art, args);
  }, `zz web test message ${STAMP}`, fn, args);
  const press = async (label) => { const r = await inCard(`const b = [...art.querySelectorAll("button")].find((x) => x.innerText.trim() === args[0] && !x.disabled); if (!b) return "no " + args[0]; b.click(); return "ok";`, label); if (r !== "ok") throw new Error(r); };
  const reason = async (why) => { const r = await inCard(`const i = art.querySelector("label input") ?? [...art.querySelectorAll("input")].find((x) => !x.getAttribute("aria-label")); if (!i) return "no input"; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, args[0]); i.dispatchEvent(new Event("input", { bubbles: true })); return "ok";`, why); if (r !== "ok") throw new Error(r); await new Promise((res) => setTimeout(res, 400)); };
  const settle = () => new Promise((r) => setTimeout(r, 2500));
  const log = () => sql(`select string_agg(action, ',' order by at, id) from moderation_log where report_id='${REP}' or (profile_id='${X.id}' and admin_id='${A.id}')`);
  await go(A.page, "/admin/reports");
  record("M1", "admin: the report is on the board with the reported message", (await inCard("return 'ok'")) === "ok");
  await press("Put on legal hold"); await reason("acceptance test hold"); await press("Put on legal hold"); await settle();
  record("M2", "Put on legal hold (with a reason)", sql(`select legal_hold::text from reports where id='${REP}'`) === "true", log());
  await press("Hide message"); await settle();
  record("M3", "Hide message → the message is removed for everyone", sql(`select (deleted_at is not null and body = '')::text from match_messages where id='${MSG}'`) === "true");
  await press("Suspend account"); { const r = await A.page.evaluate(() => { const i = document.querySelector('input[id^="reason-"]'); if (!i) return "no input"; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(i, "acceptance test suspension"); i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; }); if (r !== "ok") throw new Error(r); await new Promise((res) => setTimeout(res, 400)); }
  await press("Suspend zz web reported"); await settle();
  record("M4", "Suspend account (with a reason)", sql(`select count(*) from account_suspensions where profile_id='${X.id}'`) === "1");
  { const r = await X.api.from("match_messages").insert({ match_id: MATCH, profile_id: X.id, body: "after suspension" }).select("id");
    const r2 = await X.api.rpc("post_match", { p_club: CLUB, p_sport: "padel", p_start: at(6, "18:00"), p_end: at(6, "19:30"), p_level_min: null, p_level_max: null, p_players_needed: 3, p_note: null, p_booking: null, p_join_mode: "open", p_token: randomUUID() });
    record("M5", "the suspended account cannot post a message or a game", [r, r2].every((x) => (errOf(x) ?? "").includes("account_suspended")), `${errOf(r)} | ${errOf(r2)}`); }
  await go(A.page, "/admin/reports");
  { const lbl = await inCard(`return [...art.querySelectorAll("button")].map((b) => b.innerText.trim()).filter((t) => t.startsWith("Lift")).join()`);
    await press("Lift suspension"); if ((await inCard(`return art.querySelector("label input") ? "reason" : "none"`)) === "reason") { await reason("acceptance test lift"); await press("Lift suspension"); }
    await settle();
    record("M6", "Lift suspension", sql(`select count(*) from account_suspensions where profile_id='${X.id}'`) === "0", lbl); }
  await go(A.page, "/admin/reports");
  await press("Mark handled"); await settle();
  record("M7", "Mark handled → closed as actioned", sql(`select status from reports where id='${REP}'`) === "actioned");
  await go(A.page, "/admin/reports?status=actioned");
  await press("Reopen"); await reason("acceptance test reopen"); await press("Reopen"); await settle();
  record("M8", "Reopen (with a reason) → open again", sql(`select status from reports where id='${REP}'`) === "open");
  await go(A.page, "/admin/reports");
  await press("Release legal hold"); await reason("acceptance test release"); await press("Release legal hold"); await settle();
  record("M9", "Release legal hold (with a reason)", sql(`select legal_hold::text from reports where id='${REP}'`) === "false");
  { const l = log();
    record("M10", "every action is in the moderation log, in order", l === "legal_hold_on,hide_message,suspend,unsuspend,resolve,reopen,legal_hold_off", l); }
  { const r1 = await T.api.rpc("admin_resolve_report", { p_report: REP, p_status: "dismissed", p_action: "x" });
    const r2 = await T.api.rpc("admin_set_legal_hold", { p_report: REP, p_hold: true, p_note: "x" });
    const r3 = await T.api.from("moderation_log").select("id").limit(1);
    record("M11", "the reporter (a player) cannot resolve, hold or read the moderation log", !!r1.error && !!r2.error && (!!r3.error || r3.data.length === 0) && sql(`select status from reports where id='${REP}'`) === "open",
      `${errOf(r1)} | ${errOf(r2)} | ${errOf(r3) ?? r3.data?.length}`); }
  await shot(A.page, "m-final");
} catch (e) {
  record("X", "test run stopped", false, e.message);
} finally {
  try { await browser?.close(); } catch {}
  cleanup();
  const left = sql(`select (select count(*) from auth.users where email like 'web-%@courtbook.test') + (select count(*) from courts where name like 'zz-web-%') + (select count(*) from clubs where slug like 'zz-web-%')`);
  record("Z1", "clean-up: no test accounts, courts, clubs, games, reports or log entries left; payment mode restored; switches off",
    left === "0" && sql(`select payment_mode from clubs where id='${CLUB}'`) === MODE && sql("select count(*) from app_settings where key in ('hide_demo_clubs','require_age_confirmation') and value = 'true'") === "0", `left: ${left}`);
}
const failed = results.filter((r) => !r.pass);
console.log(`\nchecks: ${results.length}, failures: ${failed.length}`);
if (failed.length) { console.log("FAILED: " + failed.map((f) => f.id).join(", ")); exitCode = 1; } else console.log("STAGING WEBSITE ACCEPTANCE OK");
process.exit(exitCode);
