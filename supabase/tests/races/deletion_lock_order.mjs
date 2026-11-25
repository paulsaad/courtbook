// 0095: account deletion versus the same person's booking attempt, raced many times on a scratch copy of the local
// test database. Before 0095 hold_slot / book_at_desk locked the profile row, then queued for courts the deletion
// already held, and the deletion then waited for that row: a deadlock (Postgres aborts one; in practice the deletion
// run). After 0095 the booking is refused (account_closed) before any court is locked: no deadlock, ever.
// Env: DB, PG_MODULE, N (races per pair, default 60), CONTROL (set when the old definitions were put back: then the
// suite only reports how many deadlocks it saw and expects at least one).
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const DB = process.env.DB, N = Number(process.env.N ?? 60), CONTROL = !!process.env.CONTROL;
let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${JSON.stringify(detail)}]`); } };
const admin = new Client({ connectionString: DB }); await admin.connect();
const q = async (s, a = []) => (await admin.query(s, a)).rows;
const one = async (s, a = []) => Object.values((await q(s, a))[0] ?? {})[0];
const FEE = await one("select id from clubs where slug = 'batroun'");
await q("update clubs set payment_mode = 'fee_online', service_fee_usd = 1, max_upcoming_bookings = 20 where id = $1", [FEE]);
const DESK = await one("select id from clubs where slug = 'other'");
await q("update clubs set payment_mode = 'at_desk', max_upcoming_bookings = 20, active = true where id = $1", [DESK]);
const U = (n) => `e7000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let n = 0, cn = 0;
const at = async (hh, d) => one(`select ((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hh]);
const court = async (club) => {
  const id = await one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 950) returning id", [club, `zz-lo-${++cn}`]);
  await q("insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ($1, $2, 127, '00:00', '23:59', 20, 'lo') on conflict do nothing", [club, id]).catch(() => {});
  return id;
};
async function sess(who) {
  const c = new Client({ connectionString: DB }); await c.connect(); await c.query("begin");
  if (who === "service") await c.query("set local role service_role");
  else {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [who, JSON.stringify({ sub: who, role: "authenticated", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }] })]);
  }
  return c;
}
async function herd(calls) {
  const ss = await Promise.all(calls.map(([w]) => sess(w)));
  return Promise.all(calls.map(async ([, s, a], i) => {
    let r; try { await ss[i].query(s, a); r = "ok"; } catch (e) { r = e.message; }
    try { await ss[i].query(r === "ok" ? "commit" : "rollback"); } catch { /* aborted */ } await ss[i].end(); return r;
  }));
}
/** A person with two live bookings on two courts (so the deletion locks those courts first) and a closed account. */
async function person(club, book) {
  const p = U(++n);
  await q("insert into auth.users (id, phone) values ($1, $2)", [p, `+9617170${String(n).padStart(4, "0")}`]);
  await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = $1", [p]);
  const c1 = await court(club), c2 = await court(club);
  for (const [c, d] of [[c1, 5], [c2, 6]]) {
    const r = await herd([[p, book, [club, c, await at("10:00", d), await at("11:00", d)]]]);
    if (r[0] !== "ok") throw new Error(`setup booking: ${r[0]}`);
  }
  await q("insert into account_deletions (subject_id, requested_via, status) values ($1, 'app', 'closed')", [p]);
  return { p, c1, c2 };
}
const HOLD = "select 1 from hold_slot($1, $2, $3, $4, gen_random_uuid())";
const DESKBOOK = "select 1 from book_at_desk($2, $3, $4, gen_random_uuid()) where $1::uuid is not null";
for (const [label, club, book] of [["hold_slot (fee_online club)", FEE, HOLD], ["book_at_desk (pay-at-the-desk club)", DESK, DESKBOOK]]) {
  let deadlocks = 0, deletionFailed = 0, other = {};
  for (let i = 0; i < N; i++) {
    const f = await person(club, book);
    // the person's app sends a new booking on one of their courts while the worker deletes their data
    const r = await herd([["service", "select delete_account_data($1, false)", [f.p]], [f.p, book, [club, f.c1, await at("14:00", 5), await at("15:00", 5)]]]);
    for (const m of r) if (/deadlock/.test(m)) deadlocks++;
    if (r[0] !== "ok") deletionFailed++;
    if (r[1] !== "ok" && !/deadlock/.test(r[1])) other[r[1].slice(0, 30)] = (other[r[1].slice(0, 30)] ?? 0) + 1;
  }
  console.log(`${label}: ${N} races, deadlocks ${deadlocks}, deletion runs failed ${deletionFailed}, booking refusals ${JSON.stringify(other)}`);
  if (CONTROL) rep(`CONTROL ${label}: the old definitions deadlock with the deletion (at least once in ${N})`, deadlocks > 0, { deadlocks });
  else rep(`${label} versus account deletion, ${N} races: no deadlock; every deletion run succeeds; every booking refused as account_closed`,
    deadlocks === 0 && deletionFailed === 0 && Object.keys(other).every((k) => /account_closed/.test(k)), { deadlocks, deletionFailed, other });
}
console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
await admin.end();
process.exit(fails ? 1 : 0);
