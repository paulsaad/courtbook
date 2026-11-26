// F1 rollout through REAL PostgREST (the server Supabase runs), with the website's own moveBooking():
//   1. before the database change (0001–0093): the 8-argument call answers PGRST202 and moveBooking falls back to
//      0091's call, which moves as today (website-first rollout);
//   2. the change applied, PostgREST's schema cache NOT yet reloaded (the minutes after applying): a desk whose view
//      is STALE can never move the booking, whichever path PostgREST takes;
//   3. after the reload: a fresh view moves; a stale view is refused booking_changed_elsewhere with no fallback;
//      old pages (5- and 4-argument calls) are refused move_needs_reload; signed out and another club's staff refused.
// LOCAL ONLY (courtbook_api, a scratch copy of courtbook_test). Run:
//   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
//   PSQL="sudo -u postgres psql" SCRIPT=f1_rollout.mjs bash supabase/tests/api/journey.sh
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { API_DB, asAnon, asUser } from "./lib.mjs";
import { moveBooking } from "../../../src/app/staff/[slug]/moveBooking.ts";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); } };
const db = new Client({ connectionString: `postgresql:///${API_DB}?host=/var/run/postgresql` }); await db.connect();
const one = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];

// fixtures (fictional): two Batroun desks, a desk of another club, three courts
const U = (n) => `f8000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MAYA = U(1), DINA = U(2), OMAR = U(3);
await db.query("insert into auth.users (id, phone) values ($1,'+96170800001'),($2,'+96170800002'),($3,'+96170800003') on conflict do nothing", [MAYA, DINA, OMAR]);
await db.query("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [[MAYA, DINA, OMAR]]);
const CLUB = await one("select id from clubs where slug = 'batroun'");
await db.query("insert into club_staff (club_id, profile_id) values ($1,$2),($1,$3) on conflict do nothing", [CLUB, MAYA, DINA]);
await db.query("insert into club_staff (club_id, profile_id) select id, $1 from clubs where slug = 'other' on conflict do nothing", [OMAR]);
const court = async (n) => one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 960) returning id", [CLUB, `zz-F1 ${n}`]);
const A = await court("A"), B = await court("B"), C = await court("C"), D = await court("D"), E = await court("E"), F = await court("F");
const at = (hhmm, d = 5) => one(`select ((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hhmm]);
const T10 = new Date(await at("10:00")).toISOString(), T11 = new Date(await at("11:00")).toISOString();
const maya = asUser(MAYA), dina = asUser(DINA), omar = asUser(OMAR);
/** counts the RPC calls a client makes (to see whether moveBooking fell back) */
const counted = (c) => { const n = { calls: 0 }; return [{ rpc: (fn, a) => { n.calls++; return c.rpc(fn, a); } }, n]; };
const where = async (id) => (await db.query("select court_id from bookings where id = $1", [id])).rows[0]?.court_id;
const walkIn = async (onCourt) => { const r = await maya.rpc("staff_book", { p_club: CLUB, p_court: onCourt, p_start: T10, p_end: T11, p_name: "zz-F1 walk-in", p_phone: null }); if (r.error) throw new Error(r.error.message); return r.data; };
const seenOn = (c) => ({ p_seen_court: c, p_seen_start: T10, p_seen_end: T11 });
const args = (id, to) => ({ p_booking: id, p_court: to, p_start: T10, p_end: T11, p_expected_price: 20 });
const has8 = async () => (await one("select to_regprocedure('move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric,uuid,timestamptz,timestamptz)') is not null")) === true;

// ------------------------------------------------------------------ 1. before the change
rep("1.0 the database is 0001–0093, without F1", !(await has8()));
let id = await walkIn(A);
let r8 = await maya.rpc("move_booking_priced", { ...args(id, B), ...seenOn(A) });
rep("1a the 8-argument call answers PGRST202 (no such function yet)", r8.error?.code === "PGRST202", r8.error);
let [cm, nm] = counted(maya);
let r = await moveBooking(cm, args(id, B), seenOn(A));
rep("1b moveBooking falls back to 0091's call, which moves as today (2 calls)", !r.error && nm.calls === 2 && (await where(id)) === B, { err: r.error, calls: nm.calls });

// ------------------------------------------------------------------ 2. the change applied, schema cache stale
await db.query(readFileSync("docs/staff-moves/sql/move_checks_what_desk_saw.draft.sql", "utf8"));
rep("2.0 F1 applied in the database (PostgREST's schema cache not reloaded)", await has8());
id = await walkIn(C);                                 // on C; Dina moves it to A; Maya's sheet still says C
await db.query("update bookings set court_id = $1 where id = $2", [A, id]);   // (Dina's move, done directly)
[cm, nm] = counted(maya);
r = await moveBooking(cm, args(id, B), seenOn(C));
const stalePath = r.error?.code === "PGRST202" || nm.calls === 2 ? "fallback" : "8-argument";
rep(`2a a STALE view cannot move the booking while the cache is stale (path: ${stalePath}; ${nm.calls} call(s))`,
  !!r.error && /booking_changed_elsewhere|move_needs_reload/.test(r.error.message) && (await where(id)) === A, { err: r.error?.message, on: await where(id) });
r = await maya.rpc("move_booking_priced", args(id, B));
rep("2b an old page's 5-argument call (stale cache or not) is refused move_needs_reload", /move_needs_reload/.test(r.error?.message ?? "") && (await where(id)) === A, r.error);

// ------------------------------------------------------------------ 3. after the schema reload
await db.query("notify pgrst, 'reload schema'");
let ready = false;
for (let i = 0; i < 40 && !ready; i++) { await sleep(250); ready = (await maya.rpc("move_booking_priced", { ...args("00000000-0000-4000-8000-000000000000", B), ...seenOn(A) })).error?.code !== "PGRST202"; }
rep("3.0 PostgREST sees the 8-argument function after the reload", ready);
[cm, nm] = counted(maya);
r = await moveBooking(cm, args(id, B), seenOn(C));
rep("3a a STALE view is refused booking_changed_elsewhere, with no fallback (1 call); the booking stays on A",
  /booking_changed_elsewhere/.test(r.error?.message ?? "") && nm.calls === 1 && (await where(id)) === A, { err: r.error?.message, calls: nm.calls });
[cm, nm] = counted(maya);
r = await moveBooking(cm, args(id, D), seenOn(A));
rep("3b a FRESH view moves it (1 call)", !r.error && nm.calls === 1 && (await where(id)) === D, { err: r.error?.message, calls: nm.calls });
// two desks, same stale view, released together: exactly one move, through real PostgREST
id = await walkIn(C);
const [ra, rb] = await Promise.all([moveBooking(maya, args(id, E), seenOn(C)), moveBooking(dina, args(id, F), seenOn(C))]);
const end = await where(id);
rep("3c two desks at once through the API (not barrier-synchronised; race.mjs proves overlap): exactly one applied, the other booking_changed_elsewhere, the booking where the winner put it",
  (!ra.error) !== (!rb.error) && /booking_changed_elsewhere/.test((ra.error ?? rb.error)?.message ?? "") && end === (ra.error ? F : E), { a: ra.error?.message, b: rb.error?.message });
r = await maya.rpc("move_booking", { p_booking: id, p_court: C, p_start: T10, p_end: T11 });   // C is free again
rep("3d an old page's 4-argument move_booking is refused move_needs_reload", /move_needs_reload/.test(r.error?.message ?? "") && (await where(id)) === end, r.error);
r = await asAnon().rpc("move_booking_priced", { ...args(id, C), ...seenOn(end) });
rep("3e signed out: refused, nothing moves", !!r.error && (await where(id)) === end, r.error);
r = await omar.rpc("move_booking_priced", { ...args(id, C), ...seenOn(end) });
rep("3f another club's desk with the right position: forbidden", /forbidden/.test(r.error?.message ?? "") && (await where(id)) === end, r.error);

console.log(`f1 rollout checks: ${oks + fails}, failures: ${fails}`);
await db.end();
process.exit(fails ? 1 : 0);
