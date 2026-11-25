// M12.3 / release integration: booking and payment STRESS under real concurrency on a scratch copy of the local
// database (fee_online club, real functions, real roles via `set local role` + JWT claims, as booking_races.mjs).
// Unlike booking_races (two sessions), every race here opens MANY sessions at once and commits each as soon as its
// call returns. Covered on top of booking_races / court_deactivation_race / races86:
//   X1  a herd of 20 players on one slot                 X6  a court block versus a hold being paid
//   X2  players, desk walk-ins and blocks on one slot    X7  the club's payment mode changed while a fee is paid
//   X3  a storm of Pay taps (mixed keys)                 X8  a staff move into a slot while a fee hold there is paid
//   X4  account deletion vs a paid booking, an open fee  X9  a reconnecting client: the same reservation token
//       payment, and a club cancellation                      several times at once, plus a new one
//   X5  account deletion vs completing a refund          X10 a random mixed workload (hundreds of operations)
// Every run checks the global invariants (no overlap, no booking over a block, money agrees with bookings, every
// succeeded attempt has its one charge, every paid fee its one kept charge, never two unresolved attempts), and every
// error any session got is classified: business refusals are expected; a deadlock, a constraint violation, a lost
// update or any other internal error is a FAIL.
// Env: DB, PG_MODULE.  Run: PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && bash supabase/tests/races/stress_m12.sh
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const DB = process.env.DB;
let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); } };
const admin = new Client({ connectionString: DB }); await admin.connect();
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];

// ------------------------------------------------------------------ fixtures
const CLUB = await one("select id from clubs where slug = 'batroun'");
await q("update clubs set payment_mode = 'fee_online', service_fee_usd = 1, cancel_cutoff_hours = 6, max_upcoming_bookings = 20, hold_minutes = 10 where id = $1", [CLUB]);
const U = (n) => `e5000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PLAYERS = Array.from({ length: 60 }, (_, i) => U(i + 1));
const STAFF = [U(101), U(102), U(103), U(104)], ADMIN = U(200);
await q("insert into auth.users (id, phone) select x, '+9617150' || lpad(n::text, 4, '0') from unnest($1::uuid[]) with ordinality t(x, n) on conflict do nothing", [[...PLAYERS, ...STAFF, ADMIN]]);
await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [[...PLAYERS, ...STAFF, ADMIN]]);
await q("update profiles set roles = '{player,admin}' where id = $1", [ADMIN]);
await q("insert into club_staff (club_id, profile_id) select $1, x from unnest($2::uuid[]) x on conflict do nothing", [CLUB, STAFF]);
let courtN = 0;
const newCourt = async () => {
  const id = await one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 950) returning id", [CLUB, `zz-stress-${++courtN}`]);
  return id;
};
const at = async (hhmm, days = 3) => one(`select ((current_date + ${days})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hhmm]);

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
  return c;
}
/** Every call in its own session; all sent at once; each commits as soon as its own call returns. */
async function herd(calls) {
  const sessions = await Promise.all(calls.map(([who]) => session(who)));
  return Promise.all(calls.map(async ([, sql, args], i) => {
    const c = sessions[i];
    let r;
    try { r = { ok: true, rows: (await c.query(sql, args)).rows }; } catch (e) { r = { ok: false, err: e.message }; }
    try { await c.query(r.ok ? "commit" : "rollback"); } catch (e) { r = { ok: false, err: `commit: ${e.message}` }; }
    await c.end();
    return r;
  }));
}
/** One call as one role, committed. */
const as = async (who, sql, args = []) => (await herd([[who, sql, args]]))[0];

// ------------------------------------------------------------------ error classification
const errors = new Map();
const EXPECTED = /attempt_evidence_conflict|block_overlaps_booking|overlaps_existing_block|not_confirmed|slot_taken|slot_blocked|hold_expired|attempt_in_progress|not_payable|already_|not_found|forbidden|account_closed|account_deletion_requested|too_many_upcoming|wrong_payment_mode|booking_not_pending|cannot_cancel|not_cancellable|attempts_exhausted|not_refund_due|refund_reference_used|token_reused|no_open_request|booking_started|not_pending|price_changed|court_inactive|court_not_found|club_not_found|outside_|beyond_booking_window|slot_in_past|payments_not_configured|not_held|bad_|closed_|booking_not_found|not_your_booking|invalid_slot|staff_only|in_the_past/;
const UNEXPECTED = /deadlock|could not serialize|duplicate key|violates|null value|does not exist|permission denied|syntax|division|out of range|internal|unexpected|lock timeout|canceling statement/i;
function note(scenario, results) {
  for (const r of results) if (!r.ok) {
    const msg = r.err.replace(/^.*?ERROR:\s*/, "").slice(0, 120);
    const key = `${UNEXPECTED.test(msg) || !EXPECTED.test(msg) ? "UNEXPECTED" : "expected"} ${msg}`;
    const e = errors.get(key) ?? { n: 0, scenarios: new Set() }; e.n++; e.scenarios.add(scenario); errors.set(key, e);
  }
}

// ------------------------------------------------------------------ invariants over the whole database
async function invariants(label) {
  const bad = {
    overlap: Number(await one(`select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period`)),
    overBlock: Number(await one(`select count(*) from bookings k join blocks x on x.court_id = k.court_id and x.period && k.period where k.status in ('confirmed','pending')`)),
    moneyBooking: Number(await one(`select count(*) from payments p join bookings b on b.id = p.booking_id where (p.status = 'pending' and b.status <> 'pending') or (p.status = 'paid' and b.status not in ('confirmed','no_show','cancelled')) or (b.status = 'expired' and p.status = 'paid')`)),
    twoPayments: Number(await one(`select count(*) from (select booking_id from payments group by booking_id having count(*) > 1) d`)),
    attemptCharge: Number(await one(`select count(*) from payment_attempts a where (a.status = 'succeeded') <> ((select count(*) from fee_charges c where c.attempt_id = a.id and c.reason is distinct from 'extra_charge') = 1)`)),
    twoUnresolved: Number(await one(`select count(*) from (select payment_id from payment_attempts where status in ('starting','open') group by 1 having count(*) > 1) d`)),
    paidKept: Number(await one(`select count(*) from payments p where p.kind = 'fee_only' and (p.status = 'paid') <> ((select count(*) from fee_charges c where c.payment_id = p.id and c.disposition = 'kept') = 1)`)),
    confirmedNoCharge: Number(await one(`select count(*) from bookings b join payments p on p.booking_id = b.id where p.kind = 'fee_only' and b.status = 'confirmed' and not exists (select 1 from fee_charges c where c.payment_id = p.id and c.disposition = 'kept')`)),
    chargeNoDisposition: Number(await one(`select count(*) from fee_charges where disposition not in ('kept','refund_due','refunded') or (disposition = 'kept') = (reason is not null)`)),
    refundTwice: Number(await one(`select count(*) from (select provider, refund_reference from fee_charges where refund_reference is not null group by 1, 2 having count(*) > 1) d`)),
    deletedStillLive: Number(await one(`select count(*) from bookings b join account_deletions d on d.subject_id = b.player_id where d.status in ('data_removed','done') and b.status in ('confirmed','pending')`)),
  };
  rep(`${label}: global invariants hold`, Object.values(bad).every((v) => v === 0), bad);
}

// helpers on top of the real functions
const holdSql = "select booking_id, payment_id from hold_slot($1,$2,$3,$4,$5)";
async function heldBy(player, court, s, e) {
  const r = await as(player, holdSql, [CLUB, court, s, e, randomUUID()]);
  if (!r.ok) throw new Error(`hold: ${r.err}`);
  // the deployment's real provider (as the gateway tests do): its money is collected, so its refunds are real ones
  await q("update payments set provider = 'whish' where id = $1", [r.rows[0].payment_id]);
  return r.rows[0];
}
async function attemptFor(player, payment) {
  const r = await as(player, "select * from start_payment_attempt($1, $2)", [payment, randomUUID()]);
  if (!r.ok) throw new Error(`attempt: ${r.err}`);
  await as("service", "select open_payment_attempt($1, $2, $3)", [r.rows[0].attempt_id, `https://gw.example/p/${r.rows[0].attempt_id}`, `S-${r.rows[0].attempt_id.slice(0, 8)}`]);
  return r.rows[0].attempt_id;
}
const success = (attempt, ref = `G-${randomUUID()}`, amount = 1) => ["service", "select record_attempt_result($1, 'succeeded', $2, $3, 'USD')", [attempt, ref, amount]];
let pn = 0;
const nextPlayer = () => PLAYERS[pn++ % PLAYERS.length];
const T = { s: await at("10:00"), e: await at("11:00"), s2: await at("12:00"), e2: await at("13:00") };

// ------------------------------------------------------------------ X1 a herd of players on one slot
for (let round = 0; round < 4; round++) {
  const court = await newCourt();
  const r = await herd(Array.from({ length: 20 }, (_, i) => [PLAYERS[i + 20 * (round % 2)], holdSql, [CLUB, court, T.s, T.e, randomUUID()]]));
  note("X1", r);
  const live = Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [court]));
  rep(`X1 20 players hold one slot at once [round ${round + 1}]: exactly one hold, 19 refused (slot_taken)`,
    live === 1 && r.filter((x) => x.ok).length === 1 && r.filter((x) => !x.ok && /slot_taken/.test(x.err)).length === 19, { live, ok: r.filter((x) => x.ok).length });
}
await q("update bookings set status = 'expired' where status = 'pending'");   // the herds' holds end (as their deadline would)
await q("update payments set status = 'expired' where status = 'pending'");
await invariants("X1");

// ------------------------------------------------------------------ X2 players, desk walk-ins and blocks on one slot
for (let round = 0; round < 4; round++) {
  const court = await newCourt();
  const calls = [
    ...Array.from({ length: 8 }, () => [nextPlayer(), holdSql, [CLUB, court, T.s, T.e, randomUUID()]]),
    ...STAFF.slice(0, 3).map((s, i) => [s, "select staff_book($1,$2,$3,$4,$5,null)", [CLUB, court, T.s, T.e, `Walk-in ${i}`]]),
    [STAFF[3], "select staff_block($1,$2,$3,$4,'Maintenance')", [CLUB, court, T.s, T.e]],
  ];
  const r = await herd(calls.sort(() => Math.random() - 0.5));
  note("X2", r);
  const live = Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [court]));
  const blocks = Number(await one("select count(*) from blocks where court_id = $1", [court]));
  rep(`X2 8 players + 3 desk walk-ins + a block on one slot at once [round ${round + 1}]: exactly one of them occupies it`, live + blocks === 1, { live, blocks });
}
await q("update bookings set status = 'expired' where status = 'pending'"); await q("update payments set status = 'expired' where status = 'pending'");
await invariants("X2");

// ------------------------------------------------------------------ X3 a storm of Pay taps
for (let round = 0; round < 4; round++) {
  const p = nextPlayer(), court = await newCourt();
  const h = await heldBy(p, court, T.s, T.e);
  const keys = Array.from({ length: 4 }, () => randomUUID());
  const calls = Array.from({ length: 12 }, (_, i) => [p, "select * from start_payment_attempt($1, $2)", [h.payment_id, keys[i % 4]]]);
  const r = await herd(calls);
  note("X3", r);
  const made = Number(await one("select count(*) from payment_attempts where payment_id = $1", [h.payment_id]));
  const okIds = new Set(r.filter((x) => x.ok).map((x) => x.rows[0].attempt_id));
  const sameKeyConsistent = keys.every((k, ki) => new Set(r.filter((x, i) => i % 4 === ki && x.ok).map((x) => x.rows[0].attempt_id)).size <= 1);
  rep(`X3 12 Pay taps with 4 different keys at once [round ${round + 1}]: one attempt; every answer that got one names it; the rest attempt_in_progress`,
    made === 1 && okIds.size === 1 && sameKeyConsistent && r.every((x) => x.ok || /attempt_in_progress/.test(x.err)), { made, okIds: okIds.size, errs: r.filter((x) => !x.ok).map((x) => x.err.slice(-40)) });
}
await invariants("X3");

// ------------------------------------------------------------------ X4 account deletion versus the person's money
for (let round = 0; round < 4; round++) {
  const p = nextPlayer();
  // a confirmed, paid booking (fee kept), and a second hold with an open attempt whose payment is arriving
  const c1 = await newCourt(), c2 = await newCourt();
  const b1 = await heldBy(p, c1, await at("10:00", 5), await at("11:00", 5));
  const a1 = await attemptFor(p, b1.payment_id);
  await as(...success(a1));
  const b2 = await heldBy(p, c2, await at("12:00", 5), await at("13:00", 5));
  const a2 = await attemptFor(p, b2.payment_id);
  await q("insert into account_deletions (subject_id, requested_via, status) values ($1, 'app', 'closed') on conflict do nothing", [p]);
  const calls = [
    ["service", "select delete_account_data($1, false)", [p]],
    success(a2),                                                                         // the open payment succeeds
    [STAFF[round % 4], "select cancel_booking($1, true)", [b1.booking_id]],              // the club cancels the paid one
    [p, holdSql, [CLUB, await newCourt(), await at("14:00", 5), await at("15:00", 5), randomUUID()]],   // and the person tries to book
  ];
  const r = await herd(calls.sort(() => Math.random() - 0.5));
  note("X4", r);
  // the data step may have lost a race to a write that committed just before it: the pipeline re-runs it (0086), so
  // do that here as the worker would, then check the end state
  await as("service", "select delete_account_data($1, false)", [p]);
  const live = Number(await one("select count(*) from bookings where player_id = $1 and status in ('pending','confirmed')", [p]));
  const charges = await q("select attempt_id, disposition, coalesce(reason,'-') reason from fee_charges where attempt_id = any($1::uuid[]) order by attempt_id", [[a1, a2]]);
  const ok = live === 0 && charges.length === 2 && charges.every((c) => ["kept", "refund_due"].includes(c.disposition));
  rep(`X4 deletion, a payment arriving, a club cancellation and a new booking at once [round ${round + 1}]: no live booking left for the person; both charges recorded with a disposition (none lost)`,
    ok, { live, charges, r: r.map((x) => (x.ok ? "ok" : x.err.slice(-50))) });
}
await invariants("X4");

// ------------------------------------------------------------------ X5 account deletion versus completing a refund
for (let round = 0; round < 4; round++) {
  const p = nextPlayer(), court = await newCourt();
  const b = await heldBy(p, court, await at("10:00", 6), await at("11:00", 6));
  const a = await attemptFor(p, b.payment_id);
  await as(...success(a));
  await as(STAFF[0], "select cancel_booking($1, true)", [b.booking_id]);                // owed back
  const charge = await one("select id from fee_charges where attempt_id = $1", [a]);
  await q("insert into account_deletions (subject_id, requested_via, status) values ($1, 'app', 'closed') on conflict do nothing", [p]);
  const ref = `RF-${randomUUID()}`;
  const r = await herd([["service", "select delete_account_data($1, false)", [p]], [ADMIN, "select complete_fee_refund($1, 1, 'provider_portal', $2)", [charge, ref]],
    [ADMIN, "select complete_fee_refund($1, 1, 'provider_portal', $2)", [charge, ref]]]);
  note("X5", r);
  const c = (await q("select disposition, refund_reference from fee_charges where id = $1", [charge]))[0];
  rep(`X5 deletion while the admin records the same refund twice [round ${round + 1}]: the refund recorded exactly once, the charge kept in the ledger`,
    c.disposition === "refunded" && c.refund_reference === ref && r.filter((x) => x.ok).length >= 2, { c, r: r.map((x) => (x.ok ? "ok" : x.err.slice(-40))) });
}
await invariants("X5");

// ------------------------------------------------------------------ X6 a court block versus a hold being paid
for (let round = 0; round < 5; round++) {
  const p = nextPlayer(), court = await newCourt();
  const b = await heldBy(p, court, T.s2, T.e2);
  const a = await attemptFor(p, b.payment_id);
  const r = await herd([success(a), [STAFF[round % 4], "select staff_block($1,$2,$3,$4,'Burst pipe')", [CLUB, court, T.s2, T.e2]],
    [STAFF[(round + 1) % 4], "select close_club($1,$2,$3,'Storm')", [CLUB, await at("12:30"), await at("12:45")]]]);
  note("X6", r);
  const st = (await q("select b.status, (select string_agg(disposition, ',') from fee_charges c where c.attempt_id = $2) ch from bookings b where b.id = $1", [b.booking_id, a]))[0];
  rep(`X6 a payment success, a court block and a club closure on the same slot at once [round ${round + 1}]: the charge is recorded (kept only if the booking stood); a block never overlaps a live booking`,
    !!st.ch && (st.status === "confirmed") === (st.ch === "kept"), { st, r: r.map((x) => (x.ok ? "ok" : x.err.slice(-40))) });
  await q("delete from blocks where court_id = $1", [court]);
}
await invariants("X6");

// ------------------------------------------------------------------ X7 the club's payment mode changes while a fee is paid
for (let round = 0; round < 4; round++) {
  const p = nextPlayer(), court = await newCourt();
  const b = await heldBy(p, court, T.s, T.e);
  const a = await attemptFor(p, b.payment_id);
  const r = await herd([success(a), [ADMIN, "select set_club_payment_mode($1, 'at_desk')", [CLUB]]]);
  note("X7", r);
  const st = (await q("select b.status, (select string_agg(disposition || ':' || coalesce(reason, '-'), ',') from fee_charges c where c.attempt_id = $2) ch from bookings b where b.id = $1", [b.booking_id, a]))[0];
  rep(`X7 a fee succeeds while the club switches to the desk [round ${round + 1}]: either confirmed with the fee kept, or the hold released and the fee owed back — never lost`,
    (st.status === "confirmed" && st.ch === "kept:-") || (st.status === "expired" && st.ch === "refund_due:not_confirmed"), st);
  await as(ADMIN, "select set_club_payment_mode($1, 'fee_online')", [CLUB]);
}
await invariants("X7");

// ------------------------------------------------------------------ X8 a staff move into a slot while a fee hold there is paid
for (let round = 0; round < 4; round++) {
  const p = nextPlayer(), target = await newCourt(), from = await newCourt();
  const desk = await as(STAFF[0], "select staff_book($1,$2,$3,$4,'Phone: Karim',null) as id", [CLUB, from, T.s, T.e]);
  const deskId = desk.rows?.[0]?.id ?? (await one("select id from bookings where court_id = $1 and status = 'confirmed'", [from]));
  const b = await heldBy(p, target, T.s, T.e);
  const a = await attemptFor(p, b.payment_id);
  const r = await herd([success(a), [STAFF[1], "select move_booking($1,$2,$3,$4)", [deskId, target, T.s, T.e]]]);
  note("X8", r);
  const live = Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [target]));
  rep(`X8 a desk booking moved onto a court whose hold is being paid [round ${round + 1}]: one occupant; the move is refused while the hold stands`,
    live === 1 && !r[1].ok, { live, move: r[1].ok ? "ok" : r[1].err.slice(-40) });
}
await invariants("X8");

// ------------------------------------------------------------------ X9 a reconnecting client
for (let round = 0; round < 4; round++) {
  const p = nextPlayer(), court = await newCourt(), token = randomUUID();
  const r = await herd([...Array.from({ length: 5 }, () => [p, holdSql, [CLUB, court, T.s, T.e, token]]), [p, holdSql, [CLUB, await newCourt(), T.s2, T.e2, randomUUID()]]]);
  note("X9", r);
  const ids = new Set(r.slice(0, 5).filter((x) => x.ok).map((x) => x.rows[0].booking_id));
  const byToken = Number(await one("select count(*) from bookings where player_id = $1 and client_token = $2", [p, token]));
  const live = Number(await one("select count(*) from bookings where player_id = $1 and status = 'pending'", [p]));
  rep(`X9 the same reservation sent 5 times at once (lost answers) plus a new one [round ${round + 1}]: one booking for the token, every answer for it names the same booking; the player ends with one hold`,
    byToken === 1 && ids.size === 1 && live === 1, { byToken, ids: ids.size, live });
}
await invariants("X9");

// ------------------------------------------------------------------ X10 a random mixed workload
{
  const courts = [await newCourt(), await newCourt(), await newCourt()];
  const slots = [["08:00", "09:00"], ["09:00", "10:00"], ["09:30", "10:30"], ["16:00", "17:00"]];
  const crew = PLAYERS.slice(40, 52);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const opsDone = {};
  for (let wave = 0; wave < 40; wave++) {
    const live = await q("select b.id, b.player_id, b.status, p.id as payment, p.kind, (select id from payment_attempts a where a.payment_id = p.id and a.status in ('starting','open') limit 1) as attempt from bookings b left join payments p on p.booking_id = b.id where b.court_id = any($1::uuid[]) and b.status in ('pending','confirmed')", [courts]);
    const holds = live.filter((b) => b.status === "pending" && b.payment && b.player_id);
    const paying = holds.filter((b) => b.attempt);
    const calls = [];
    for (let i = 0; i < 8; i++) {
      // payments are made far more often than the rest, so that the money paths race each other and the desk
      const kind = pick(["hold", "hold", "pay", "pay", "succeed", "succeed", "succeed", "fail", "cancel", "clubcancel", "release", "walkin", "block", "move"]);
      const b = live.length ? pick(live) : null;
      const h = holds.length ? pick(holds) : null;
      const a = paying.length ? pick(paying) : null;
      const [s, e] = pick(slots);
      const court = pick(courts);
      const day = 7 + (wave % 3);
      if (kind === "hold") calls.push([kind, pick(crew), holdSql, [CLUB, court, await at(s, day), await at(e, day), randomUUID()]]);
      else if (kind === "pay" && h) calls.push([kind, h.player_id, "select * from start_payment_attempt($1,$2)", [h.payment, randomUUID()]]);
      else if (kind === "succeed" && a) calls.push([kind, ...success(a.attempt)]);
      else if (kind === "fail" && a) calls.push([kind, "service", "select record_attempt_result($1,'failed')", [a.attempt]]);
      else if (kind === "cancel" && b?.player_id) calls.push([kind, b.player_id, "select cancel_booking($1,false)", [b.id]]);
      else if (kind === "clubcancel" && b) calls.push([kind, pick(STAFF), "select cancel_booking($1,true)", [b.id]]);
      else if (kind === "release" && h) calls.push([kind, h.player_id, "select release_hold($1)", [h.id]]);
      else if (kind === "walkin") calls.push([kind, pick(STAFF), "select staff_book($1,$2,$3,$4,'Walk-in',null)", [CLUB, court, await at(s, day), await at(e, day)]]);
      else if (kind === "block") calls.push([kind, pick(STAFF), "select staff_block($1,$2,$3,$4,'Repair')", [CLUB, court, await at(s, day), await at(e, day)]]);
      else if (kind === "move" && b) calls.push([kind, pick(STAFF), "select move_booking($1,$2,$3,$4)", [b.id, pick(courts), await at(s, day), await at(e, day)]]);
    }
    const r = await herd(calls.map(([, ...c]) => c));
    calls.forEach(([k], i) => { const key = `${k}:${r[i].ok ? "ok" : "refused"}`; opsDone[key] = (opsDone[key] ?? 0) + 1; });
    // new holds pay with the real provider; new attempts get a provider page, as the server would do
    for (const [i, x] of r.entries()) {
      if (x.ok && calls[i][0] === "hold") await q("update payments set provider = 'whish' where id = $1", [x.rows[0].payment_id]);
      if (x.ok && calls[i][0] === "pay" && x.rows[0]?.status === "starting")
        await as("service", "select open_payment_attempt($1,$2,$3)", [x.rows[0].attempt_id, `https://gw.example/p/${x.rows[0].attempt_id}`, `S-${x.rows[0].attempt_id.slice(0, 8)}`]);
    }
    note("X10", r);
    if (wave % 10 === 9) await q("delete from blocks where court_id = any($1::uuid[])", [courts]);
  }
  console.log("X10 operations:", JSON.stringify(opsDone));
  await invariants("X10 (after ~320 random operations in waves of 8 concurrent)");
}

// ------------------------------------------------------------------ errors seen
const lines = [...errors.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${String(v.n).padStart(4)}  ${k}  (${[...v.scenarios].join(",")})`);
console.log("errors seen:\n" + lines.join("\n"));
const unexpected = [...errors.keys()].filter((k) => k.startsWith("UNEXPECTED"));
rep("E no deadlock, constraint violation or internal error in any session (only business refusals)", unexpected.length === 0, unexpected);

console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
await admin.end();
process.exit(fails ? 1 : 0);
