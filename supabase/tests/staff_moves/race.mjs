// F1 under real concurrency: two desks move the same booking at the same moment, and a move races a cancellation.
// Scratch database only (staff_moves/run.sh builds it). Fictional people (fixtures.sql).
//   MODE=draft    the draft is applied: every round must end with exactly one move applied, the other refused
//                 'booking_changed_elsewhere', and the booking where the winner put it.
//   MODE=control  the database as 0091 left it (5-argument call, no comparison): the second move is applied too. The
//                 harness must SEE that (otherwise it could not catch the defect), so this mode passes only if
//                 every simultaneous round shows both moves applied.
// Orders, as in races/booking_races.mjs:
//   sim  both calls released together: each actor waits on a shared advisory lock the controller holds, and the
//        controller releases it once both are waiting (pg_locks);
//   ab   A's call runs inside an open transaction; B's starts while A is uncommitted (a delayed submission that
//        blocks on A's locks); A commits, then B finishes;
//   ba   the same, B first.
// Env: DB (connection string), PG_MODULE (folder holding node_modules/pg), MODE, ROUNDS (simultaneous rounds, ≥ 20).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const DB = process.env.DB, MODE = process.env.MODE ?? "draft", ROUNDS = Number(process.env.ROUNDS ?? 20);
let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${detail}]`); } };
const admin = new Client({ connectionString: DB }); await admin.connect();
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BARRIER = 424242;

const U = (n) => `f7000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MAYA = U(2), DINA = U(3);
const CLUB = await one("select id from clubs where slug = 'batroun'");
let courtN = 0;
const newCourt = async () => one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 900) returning id", [CLUB, `zz-f1-${process.pid}-${++courtN}`]);
const at = async (hhmm, days = 4) => one(`select ((current_date + ${days})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hhmm]);
const T10 = await at("10:00"), T11 = await at("11:00");

async function session(who) {
  const c = new Client({ connectionString: DB }); await c.connect();
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claim.sub', $1, true)", [who]);
  return {
    pid: (await c.query("select pg_backend_pid() as p")).rows[0].p,
    async run(sql, args) { try { const r = await c.query(sql, args); return { ok: true, rows: r.rows }; } catch (e) { return { ok: false, err: e.message }; } },
    async end() { try { await c.query("commit"); } catch { /* aborted: rolls back */ } await c.end(); },
  };
}
/** a, b = [who, sql, args]. Returns [resA, resB]. */
async function race(order, a, b) {
  if (order === "sim") {
    const ctl = new Client({ connectionString: DB }); await ctl.connect();
    await ctl.query("select pg_advisory_lock($1)", [BARRIER]);
    const [sa, sb] = await Promise.all([session(a[0]), session(b[0])]);
    const go = (s, x) => s.run("select pg_advisory_xact_lock_shared($1)", [BARRIER])
      .then(() => s.run(x[1], x[2])).then(async (r) => { await s.end(); return r; });
    const pa = go(sa, a), pb = go(sb, b);
    for (let i = 0; i < 200; i++) {   // both actors are waiting on the barrier
      const n = Number((await ctl.query("select count(*) as n from pg_locks where locktype = 'advisory' and objid = $1 and not granted and pid = any($2)",
        [BARRIER, [sa.pid, sb.pid]])).rows[0].n);
      if (n === 2) break;
      await sleep(10);
    }
    await ctl.query("select pg_advisory_unlock($1)", [BARRIER]);
    const res = await Promise.all([pa, pb]);
    await ctl.end();
    return res;
  }
  const [first, second] = order === "ab" ? [a, b] : [b, a];
  const s1 = await session(first[0]), s2 = await session(second[0]);
  const r1 = await s1.run(first[1], first[2]);
  const p2 = s2.run(second[1], second[2]);   // blocks on the first's locks while it is uncommitted
  await sleep(250);
  await s1.end();
  const r2 = await p2;
  await s2.end();
  return order === "ab" ? [r1, r2] : [r2, r1];
}
const short = (r) => (r.ok ? "ok" : r.err.replace(/^.*?ERROR:\s*/, "").slice(0, 60));
const where = async (id) => (await q("select court_id, status from bookings where id = $1", [id]))[0];
const walkIn = async (court) => {   // Maya enters a walk-in at the desk
  const s = await session(MAYA); const r = await s.run("select staff_book($1,$2,$3,$4,'zz-f1 walk-in')::text as id", [CLUB, court, T10, T11]); await s.end();
  if (!r.ok) throw new Error(r.err); return r.rows[0].id;
};
const move = (id, to, seen) => MODE === "control"
  ? ["select move_booking_priced($1,$2,$3,$4,20)::text", [id, to, T10, T11]]
  : ["select move_booking_priced($1,$2,$3,$4,20,$5,$3,$4)::text", [id, to, T10, T11, seen]];

const ORDERS = [...Array(ROUNDS).fill("sim"), "ab", "ab", "ab", "ba", "ba", "ba"];

// R1. two desks move the same booking (both opened it on court X)
let both = 0, simRounds = 0;
for (const [i, order] of ORDERS.entries()) {
  const x = await newCourt(), y = await newCourt(), z = await newCourt();
  const id = await walkIn(x);
  const [rd, rm] = await race(order, [DINA, ...move(id, y, x)], [MAYA, ...move(id, z, x)]);
  const w = await where(id);
  if (order === "sim") simRounds++;
  if (rd.ok && rm.ok) both++;
  if (MODE === "control") continue;
  const winner = rd.ok ? y : z, loser = rd.ok ? rm : rd;
  rep(`R1.${i + 1} [${order}] two desks move it at once: exactly one applied, the other refused, the booking where the winner put it`,
    rd.ok !== rm.ok && !loser.ok && /booking_changed_elsewhere/.test(loser.err) && w.court_id === winner && w.status === "confirmed",
    `${short(rd)} | ${short(rm)} | on ${w.court_id === y ? "Y" : w.court_id === z ? "Z" : w.court_id === x ? "X" : "?"}`);
}
if (MODE === "control") rep(`control: without the comparison both moves are applied in ${both}/${ORDERS.length} rounds (all ${simRounds} simultaneous included)`, both === ORDERS.length, `${both}`);

// R2. a desk moves it while it is being cancelled
if (MODE !== "control") {
  let moved = 0, refused = 0;
  for (const [i, order] of ORDERS.entries()) {
    const x = await newCourt(), y = await newCourt();
    const id = await walkIn(x);
    const [rmv, rc] = await race(order, [DINA, ...move(id, y, x)], [MAYA, "select cancel_booking($1)::text", [id]]);
    const w = await where(id);
    const ok = rc.ok && w.status === "cancelled" && (rmv.ok ? w.court_id === y : /not_confirmed/.test(rmv.err) && w.court_id === x);
    if (rmv.ok) moved++; else refused++;
    rep(`R2.${i + 1} [${order}] move versus cancel: the cancel stands; the move either came first (cancelled where it was moved) or was refused not_confirmed (cancelled where it was)`,
      ok, `${short(rmv)} | ${short(rc)} | ${w.status} on ${w.court_id === y ? "Y" : w.court_id === x ? "X" : "?"}`);
  }
  console.log(`      (move first in ${moved} rounds, cancel first in ${refused})`);
}

// global invariant: no two live bookings overlap on a court
const overlaps = Number(await one(`select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id
  and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period`));
rep("I1 no two live bookings overlap on any court", overlaps === 0, `${overlaps}`);
console.log(`race checks: ${oks + fails}, failures: ${fails}`);
await admin.end();
process.exit(fails ? 1 : 0);
