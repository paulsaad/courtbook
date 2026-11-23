// M3 game actions, end to end on STAGING (suite m3-actions). The app (signed in as the run's own
// account, "Emma") does the actions under test; this helper plays the other side through Supabase's
// API under real sessions (two helper players), and checks every outcome in the database.
//
//   setup            helpers, three games, Emma's court booking; writes ids to $OUT/m3.env
//   decline-emma     the organiser of game A declines Emma's request (API, as helper 1)
//   cancel-booking   Emma's court booking under game B is cancelled (API, as Emma)
//   check <step>     database checks after each app step: asked, declined, left, decided, court-lost, resolved
//   helpers | posted | edited | chat-sent   suite m3-post-chat: Post a game, Edit game, chat
//   cleanup          this run's games and helper accounts only (Emma's own account: staging.mjs cleanup)
//
// Staging only (refuses anything else). No password, token or code is ever printed.
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { runEmail } from "./runAccount.mjs";

const STAGING_REF = "pwznauyioqykdwodwpvx";
const LIVE_REF = "lgujfbwunokobjxlvpuf";
const env = process.env;
const URL_ = env.STAGING_SUPABASE_URL, SERVICE = env.STAGING_SERVICE_ROLE_KEY, DB = env.STAGING_DB_URL, ANON = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
for (const [k, v] of Object.entries({ URL_, SERVICE, DB, ANON })) if (!v) throw new Error(`${k} missing`);
if (!URL_.includes(STAGING_REF) || URL_.includes(LIVE_REF) || !DB.includes(STAGING_REF) || DB.includes(LIVE_REF)) {
  throw new Error("Refusing: these settings are not the staging project.");
}
const RUN = env.GITHUB_RUN_ID ?? "local", ATTEMPT = env.GITHUB_RUN_ATTEMPT ?? "1";
const EMMA = runEmail(RUN, ATTEMPT);
const helperEmail = (n) => EMMA.replace("@", `-h${n}@`);   // e2e-android-<run>-<attempt>-h1@courtbook.test
const HELPER_RE = /^e2e-android-(\d{1,20}|local)-\d{1,3}-h[12]@courtbook\.test$/;
const IDS = `${env.OUT ?? "e2e/out"}/m3.env`;
const PW_FILE = "/tmp/m3-helpers.json"; // helper passwords: this runner only, never printed

const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-At", "-c", q], { encoding: "utf8" }).trim();
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const ids = () => Object.fromEntries(fs.readFileSync(IDS, "utf8").trim().split("\n").map((l) => l.split("=")));
const uuid = (v) => { if (!/^[0-9a-f-]{36}$/.test(v)) throw new Error(`not a uuid: ${v}`); return v; };

async function as(email, password) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return c;
}
async function call(c, fn, args) {
  const { data, error } = await c.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}
const emma = () => as(EMMA, env.E2E_PASSWORD);
const helper = (n) => as(helperEmail(n), JSON.parse(fs.readFileSync(PW_FILE, "utf8"))[n]);

function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
}
const statusOf = (game, email) =>
  sql(`select coalesce((select mp.status from match_players mp join auth.users u on u.id = mp.profile_id
        where mp.match_id = '${uuid(game)}' and u.email = '${email}'), 'none')`);

async function createHelpers() {
  const pw = {};
  for (const [n, name] of [[1, "Hadi Helper"], [2, "Nour Helper"]]) {
    pw[n] = randomBytes(18).toString("base64url");
    const { data, error } = await admin.auth.admin.createUser({ email: helperEmail(n), password: pw[n], email_confirm: true });
    if (error) throw new Error(`createUser h${n}: ${error.message}`);
    sql(`update profiles set name='${name}' where id='${uuid(data.user.id)}'`);
    // 18+ (0080): automated accounts confirm in server context, so the age question never covers the screen under test
    sql(`do $$ begin update profiles set age_confirmed_at = coalesce(age_confirmed_at, now()), age_confirmed_via = coalesce(age_confirmed_via, 'app') where id = '${uuid(data.user.id)}'; exception when undefined_column then null; end $$`);
  }
  fs.writeFileSync(PW_FILE, JSON.stringify(pw), { mode: 0o600 });
  fs.mkdirSync(IDS.replace(/\/[^/]+$/, ""), { recursive: true });
  if (!fs.existsSync(IDS)) fs.writeFileSync(IDS, "");
}

async function setup() {
  const CLUB = uuid(sql("select id from clubs where slug='batroun'"));
  await createHelpers();
  const [h1, me] = [await helper(1), await emma()];

  // Games without a court, organised by helper 1, three days ahead (no levels: nothing to confirm but the court).
  const day = new Date(Date.now() + 3 * 864e5); day.setUTCHours(17, 0, 0, 0);
  const end = new Date(day.getTime() + 90 * 6e4);
  const post = (c, mode, extra = {}) => call(c, "post_match", {
    p_club: CLUB, p_sport: "padel", p_start: day.toISOString(), p_end: end.toISOString(), p_level_min: null, p_level_max: null,
    p_players_needed: 3, p_note: "M3 staging check", p_booking: null, p_join_mode: mode, ...extra });
  const GA = await post(h1, "approval");
  const GO = await post(h1, "open");

  // Emma books a real court at the desk (the club is at the desk for this run: staging.mjs prepare),
  // posts an approval game on it, and both helpers ask to join.
  const date = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
  const slots = (await call(me, "club_day_slots", { p_date: date, p_sport: "padel" })).filter((s) => s.club_id === CLUB);
  const s = slots.map((x) => ({ ...x, dur: Math.max(x.min_minutes, 60) })).filter((x) => x.free_minutes >= x.dur && x.dur <= x.max_minutes).pop();
  if (!s) throw new Error(`no free padel slot at the demo club on ${date}`);
  const bEnd = new Date(Date.parse(s.start_at) + s.dur * 6e4).toISOString();
  const [b] = await call(me, "book_at_desk", { p_court: s.court_id, p_start: s.start_at, p_end: bEnd, p_token: randomUUID() });
  const GB = await call(me, "post_match", {
    p_club: null, p_sport: "padel", p_start: null, p_end: null, p_level_min: null, p_level_max: null,
    p_players_needed: 2, p_note: "M3 staging check (court)", p_booking: b.booking_id, p_join_mode: "approval" });
  await call(h1, "join_match", { p_match: GB });
  await call(await helper(2), "join_match", { p_match: GB });

  fs.mkdirSync(IDS.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(IDS, `GA=${GA}\nGO=${GO}\nGB=${GB}\nBOOKING=${b.booking_id}\n`);
  console.log(`setup: games A (approval) ${GA}, open ${GO}, B (Emma's, court ${s.court_name} ${s.start_at}) ${GB}`);
  check("B has two waiting requests", sql(`select count(*) from match_players where match_id='${uuid(GB)}' and status='pending'`) === "2");
}

async function declineEmma() {
  const { GA } = ids();
  const emmaId = uuid(sql(`select id from auth.users where email='${EMMA}'`));
  await call(await helper(1), "decide_join", { p_match: GA, p_profile: emmaId, p_accept: false });
  console.log("helper 1 declined Emma's request for game A");
}

async function cancelBooking() {
  const { BOOKING } = ids();
  await call(await emma(), "cancel_booking", { p_booking: BOOKING, p_club_caused: false });
  console.log("Emma's court booking under game B cancelled");
}

function checkStep(step) {
  const { GA, GO, GB, BOOKING } = ids();
  const m = (col) => sql(`select ${col} from matches where id='${uuid(GB)}'`);
  const note = (email, kind, game) => sql(`select count(*) from notifications n join auth.users u on u.id = n.profile_id
    where u.email='${email}' and n.kind='${kind}' and n.match_id='${uuid(game)}'`);
  switch (step) {
    case "asked":
      check("A: Emma's request is waiting", statusOf(GA, EMMA) === "pending", statusOf(GA, EMMA));
      check("A: the organiser was told", Number(note(helperEmail(1), "join_request", GA)) >= 1);
      break;
    case "declined":
      check("A: Emma is declined", statusOf(GA, EMMA) === "declined", statusOf(GA, EMMA));
      check("A: Emma was told", Number(note(EMMA, "join_declined", GA)) >= 1);
      break;
    case "left":
      check("open game: Emma joined (organiser told)", Number(note(helperEmail(1), "player_joined", GO)) >= 1);
      check("open game: Emma left (row gone, organiser told)", statusOf(GO, EMMA) === "none" && Number(note(helperEmail(1), "player_left", GO)) >= 1, statusOf(GO, EMMA));
      break;
    case "decided": {
      const [s1, s2] = [statusOf(GB, helperEmail(1)), statusOf(GB, helperEmail(2))];
      check("B: one request declined, one accepted", [s1, s2].sort().join(",") === "accepted,declined", `h1 ${s1}, h2 ${s2}`);
      break;
    }
    case "court-lost":
      check("B: booking cancelled", sql(`select status from bookings where id='${uuid(BOOKING)}'`) === "cancelled");
      check("B: court lost, link removed, joining paused", m("court_lost_at is not null and booking_id is null and status = 'closed' and closed_reason = 'no_court'") === "t",
        m("status || '/' || coalesce(closed_reason, '-')"));
      check("B: Emma (organiser) told to choose", Number(note(EMMA, "booking_unlinked", GB)) >= 1);
      break;
    case "resolved": {
      check("B: goes ahead without a court, open again", m("court_lost_at is null and booking_id is null and status = 'open' and closed_reason is null") === "t",
        m("status || '/' || coalesce(closed_reason, '-')"));
      const accepted = [1, 2].map(helperEmail).find((e) => statusOf(GB, e) === "accepted");
      check("B: the accepted player was told", !!accepted && Number(note(accepted, "court_resolved", GB)) >= 1);
      break;
    }
    default: throw new Error(`unknown step ${step}`);
  }
}

// ---- Post a game, edit, chat (suite m3-post-chat) ----
const addId = (k, v) => fs.appendFileSync(IDS, `${k}=${v}\n`);

/** The game Emma just posted in the app: approval, 3 players, her note; then helper 1 asks to join. */
async function posted() {
  const row = sql(`select m.id || '|' || m.join_mode || '|' || m.players_needed || '|' || coalesce(m.note, '') || '|' || m.status || '|' || (m.booking_id is null)
    from matches m join auth.users u on u.id = m.organizer_id where u.email = '${EMMA}' order by m.created_at desc limit 1`);
  const [id, mode, needed, note, status, noBooking] = row.split("|");
  check("posted from the app: one game, organised by Emma", !!id, row);
  if (!id) return;
  addId("GP", uuid(id));
  check("posted with Ask to join, 3 players, her note, open, no booking",
    mode === "approval" && needed === "3" && note === "M3 staging check post" && status === "open" && noBooking === "true", row);
  check("exactly one game posted (no duplicate)", sql(`select count(*) from matches m join auth.users u on u.id = m.organizer_id where u.email = '${EMMA}'`) === "1");
  // 0073: the app sent its own key with the post (POST_TOKEN_AVAILABLE on staging), so a retry could not duplicate it
  check("posted with the app's key (0073 client_token set)", sql(`select (client_token is not null)::text from matches where id = '${uuid(id)}'`) === "true");
  await call(await helper(1), "join_match", { p_match: id });
  check("helper 1's request is waiting", statusOf(id, helperEmail(1)) === "pending", statusOf(id, helperEmail(1)));
}

/** After Edit -> Join straight away: the waiting request was accepted (S15) and helper 1 told. */
function edited() {
  const { GP } = ids();
  check("edited to Join straight away", sql(`select join_mode from matches where id='${uuid(GP)}'`) === "open");
  check("the waiting request was accepted (S15)", statusOf(GP, helperEmail(1)) === "accepted", statusOf(GP, helperEmail(1)));
  const told = sql(`select count(*) from notifications n join auth.users u on u.id = n.profile_id where u.email='${helperEmail(1)}' and n.kind='join_accepted' and n.match_id='${uuid(GP)}'`);
  check("helper 1 was told", Number(told) >= 1, told);
}

/** Emma's message arrived once; helper 1 answers through the API; an outsider reads nothing. */
async function chatSent() {
  const { GP } = ids();
  const n = sql(`select count(*) from match_messages x join auth.users u on u.id = x.profile_id where x.match_id='${uuid(GP)}' and u.email='${EMMA}' and x.body='See you at six'`);
  check("Emma's message saved once, server-stamped", n === "1", n);
  const h1 = await helper(1);
  const { error } = await h1.from("match_messages").insert({ match_id: GP, profile_id: sql(`select id from auth.users where email='${helperEmail(1)}'`), body: "On my way" });
  check("helper 1 answers in the chat", !error, error?.message ?? "");
  const { data } = await (await helper(2)).rpc("match_messages_list", { p_match: GP, p_after: null });
  check("a player not in the game reads nothing", Array.isArray(data) && data.length === 0, JSON.stringify(data ?? null).slice(0, 80));
}

function cleanup() {
  const emails = [EMMA, helperEmail(1), helperEmail(2)];
  for (const e of emails.slice(1)) if (!HELPER_RE.test(e)) throw new Error(`refusing to clean up ${e}`);
  const who = `(select id from auth.users where email in (${emails.map((e) => `'${e}'`).join(",")}))`;
  // Only games organised by this run's three accounts; players, messages and notices of those games go with them.
  const n = sql(`with g as (select id from matches where organizer_id in ${who})
    , a as (delete from notifications where match_id in (select id from g) or actor_id in ${who} returning 1)
    , b as (delete from match_messages where match_id in (select id from g) returning 1)
    , c as (delete from match_players where match_id in (select id from g) or profile_id in ${who} returning 1)
    select count(*) from g`);
  sql(`delete from matches where organizer_id in ${who}`);
  sql(`delete from auth.users where email in ('${helperEmail(1)}', '${helperEmail(2)}')`);
  console.log(`m3 cleanup: ${n} game(s) of this run removed, helper accounts removed`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "setup") await setup();
else if (cmd === "decline-emma") await declineEmma();
else if (cmd === "cancel-booking") await cancelBooking();
else if (cmd === "check") checkStep(arg);
else if (cmd === "helpers") await createHelpers();
else if (cmd === "posted") await posted();
else if (cmd === "edited") edited();
else if (cmd === "chat-sent") await chatSent();
else if (cmd === "cleanup") cleanup();
else throw new Error("setup | decline-emma | cancel-booking | check <step> | helpers | posted | edited | chat-sent | cleanup");
