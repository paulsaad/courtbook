// Booking vs court deactivation under real concurrency (review 24 Nov, 0092): two committed sessions on a scratch copy
// of the local replica. A desk booking (staff_book, confirmed), a player hold (hold_slot, pending) and a player's
// pay-at-the-desk booking (book_at_desk, confirmed), a direct server-side insert and a desk move onto the court each
// race the club desk switching the same court off:
//   ab   the booking runs first inside an open transaction; the deactivation starts while it is uncommitted;
//   ba   the deactivation runs first inside an open transaction; the booking starts while it is uncommitted;
//   sim  both sent at the same instant (5 times).
// Required in every run: exactly one of the two succeeds, and afterwards no live (confirmed or pending) future booking
// sits on an inactive court anywhere in the database.
// Env: DB (connection string of the scratch database), PG_MODULE (folder holding node_modules/pg).
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const DB = process.env.DB;
let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${detail}]`); } };
const admin = new Client({ connectionString: DB }); await admin.connect();
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIM = await one("select id from clubs where slug = 'batroun'");     // takes app payments (simulated): holds
const DESK = await one("select id from clubs where slug = 'other'");      // pay at the desk: book_at_desk
await q("update clubs set payment_mode = 'simulated' where id = $1", [SIM]);
await q("update clubs set payment_mode = 'at_desk' where id = $1", [DESK]);
const U = (n) => `da000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const S_SIM = U(2), S_DESK = U(3);
await q(`insert into auth.users (id, phone) values ($1,'+96170900002'),($2,'+96170900003') on conflict do nothing`, [S_SIM, S_DESK]);
await q("insert into club_staff (club_id, profile_id) values ($1,$2),($3,$4) on conflict do nothing", [SIM, S_SIM, DESK, S_DESK]);
// a fresh player per run (one open hold per player is a separate rule)
let pn = 10;
async function freshPlayer() {
  const id = U(++pn);
  await q("insert into auth.users (id, phone) values ($1, $2) on conflict do nothing", [id, `+9617091${String(pn).padStart(4, "0")}`]);
  await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = $1", [id]);
  return id;
}
let courtN = 0;
const newCourt = async (club) => one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 950) returning id", [club, `zz-off-${++courtN}`]);
const at = async (hhmm, days = 3) => one(`select ((current_date + ${days})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hhmm]);
const T10 = await at("10:00"), T11 = await at("11:00");

// ------------------------------------------------------------------ sessions
async function session(who) {
  const c = new Client({ connectionString: DB }); await c.connect();
  await c.query("begin");
  if (who === "service") { await c.query("set local role service_role"); await c.query("select set_config('request.jwt.claim.sub', '', true)"); }
  else {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [who, JSON.stringify({ sub: who, role: "authenticated", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }] })]);
  }
  return {
    async run(sql, args) { try { const r = await c.query(sql, args); return { ok: true, rows: r.rows }; } catch (e) { return { ok: false, err: e.message }; } },
    async end() { try { await c.query("commit"); } catch { /* aborted: rolls back */ } await c.end(); },
  };
}
/** a = [who, sql, args], b likewise. Returns [resA, resB] in the order a, b. */
async function race(mode, a, b) {
  if (mode === "sim") {
    const [sa, sb] = await Promise.all([session(a[0]), session(b[0])]);
    // each commits as soon as its call returns (the other may be waiting on its locks)
    const done = (s, x) => s.run(x[1], x[2]).then(async (r) => { await s.end(); return r; });
    return Promise.all([done(sa, a), done(sb, b)]);
  }
  const [first, second] = mode === "ab" ? [a, b] : [b, a];
  const s1 = await session(first[0]), s2 = await session(second[0]);
  const r1 = await s1.run(first[1], first[2]);
  const p2 = s2.run(second[1], second[2]);       // starts while the first is uncommitted (blocks on its locks, or not)
  await sleep(250);
  await s1.end();
  const r2 = await p2;
  await s2.end();
  return mode === "ab" ? [r1, r2] : [r2, r1];
}
const short = (r) => (r.ok ? "ok" : r.err.replace(/^.*?ERROR:\s*/, "").slice(0, 60));

// ------------------------------------------------------------------ races
const kinds = [
  ["desk booking (staff_book, confirmed)", SIM, S_SIM, async (court) => [S_SIM, "select staff_book($1,$2,$3,$4,'Phone: race',null)::text as id", [SIM, court, T10, T11]]],
  ["player hold (hold_slot, pending)", SIM, S_SIM, async (court) => [await freshPlayer(), "select booking_id::text as id from hold_slot($1,$2,$3,$4)", [SIM, court, T10, T11]]],
  ["player pay-at-desk booking (book_at_desk, confirmed)", DESK, S_DESK, async (court) => [await freshPlayer(), "select booking_id::text as id from book_at_desk($1,$2,$3,$4)", [court, T10, T11, randomUUID()]]],
  // a server-side write with the server key, straight into bookings: no booking function, so no incidental
  // re-check (quote_price also re-reads the court after the lock); only 0092's bookings_need_active_court guards it
  ["server-side insert (service role, direct)", SIM, S_SIM, async (court) => ["service",
    "insert into bookings (club_id, court_id, start_at, end_at, status, source, price_usd, fee_usd, guest_name) values ($1,$2,$3,$4,'confirmed','staff',20,0,'Server') returning id::text as id", [SIM, court, T10, T11]]],
  // the desk moves an existing booking from another court onto this one
  ["desk move onto the court (move_booking_priced)", SIM, S_SIM, async (court) => {
    const from = await newCourt(SIM);
    const id = await one(`insert into bookings (club_id, court_id, start_at, end_at, status, source, price_usd, fee_usd, guest_name, created_by)
      values ($1,$2,$3,$4,'confirmed','staff',20,0,'Mover',$5) returning id`, [SIM, from, T10, T11, S_SIM]);
    return [S_SIM, "select move_booking_priced($1,$2,$3,$4,20)::text as id", [id, court, T10, T11]];
  }],
];
// the move needs 0091 (#23); on a branch without it the move races are skipped and say so
const hasMove = await one("select to_regprocedure('move_booking_priced(uuid,uuid,timestamptz,timestamptz,numeric)') is not null");
if (!hasMove) { kinds.pop(); console.log("skip  desk move onto the court: move_booking_priced (0091) is not on this branch"); }
for (const [label, club, staff, mk] of kinds) {
  for (const mode of ["ab", "ba", "sim", "sim", "sim", "sim", "sim"]) {
    const court = await newCourt(club);
    const book = await mk(court);
    const off = [staff, "update courts set active = false where id = $1 returning id", [court]];
    const [rb, ro] = await race(mode, book, off);
    const offDone = ro.ok && ro.rows.length === 1;
    const [{ active, live }] = await q("select (select active from courts where id = $1) as active, (select count(*)::int from bookings where court_id = $1 and status in ('confirmed','pending') and end_at > now()) as live", [court]);
    const exactlyOne = rb.ok !== offDone;
    const consistent = (rb.ok && active && live === 1) || (offDone && !active && live === 0);
    const expect = mode === "ab" ? rb.ok && !offDone && /court_has_bookings/.test(ro.err ?? "")
                 : mode === "ba" ? !rb.ok && offDone && /court_not_found/.test(rb.err ?? "")
                 : true;
    const what = mode === "ab" ? "booking first → deactivation refused (court_has_bookings)"
               : mode === "ba" ? "deactivation first → booking refused (court_not_found)" : "simultaneous → exactly one wins";
    if (process.env.VERBOSE) console.log(`   ${mode} booking=${short(rb)} deactivation=${ro.ok ? "ok" : short(ro)}`);
    rep(`${label} · ${mode}: ${what}; final state consistent`, exactlyOne && consistent && expect,
      `booking=${short(rb)} deactivation=${ro.ok ? (offDone ? "ok" : "no row") : short(ro)} court active=${active} live bookings=${live}`);
  }
}
const bad = await one(`select count(*)::int from bookings b join courts c on c.id = b.court_id
  where not c.active and b.status in ('confirmed', 'pending') and b.end_at > now()`);
rep("global: no confirmed or pending future booking on an inactive court anywhere in the database", bad === 0, `${bad} found`);

await admin.end();
console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(fails ? 1 : 0);
