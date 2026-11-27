// Adversarial booking and payment suite (overnight assignment of 26 Nov, priority 2). An independent attempt to break
// the booking and payment rules on a scratch database migrated to 0096, with real roles (`set local role` + JWT
// claims) and real concurrency (one connection per caller, all calls sent at once). Every scenario states its
// invariant and checks the database afterwards; the global invariants G1–G9 are checked after every scenario.
//
//   S1  two players, one slot                      S9  delayed / out-of-order provider answers
//   S2  player hold vs desk walk-in                S10 releasing a hold while its payment is confirmed
//   S3  two desk walk-ins at once                  S11 duplicate refund completions (fee and court-and-fee)
//   S4  an expiring hold vs its payment            S12 a staff move vs a new hold on the target slot
//   S5  paying a hold whose slot another took      S13 extending a booking into an occupied slot
//   S6  money taken, booking cannot be confirmed   S14 one reservation token sent many times at once
//   S7  lost answers: hold, Pay and result again   S15 a database failure part way (fault injected)
//   S8  the same success reported many times       S16 a closing account trying to book or pay
//
// A business refusal (slot_taken, hold_expired, account_closed, …) is an expected answer. A deadlock, a serialization
// failure, a constraint violation surfacing as such, or any unclassified error is a FAIL.
// Env: DB (connection string), PG_MODULE (folder holding node_modules/pg). LOCAL ONLY.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const DB = process.env.DB;
if (!DB || !/\/\/\/[a-z0-9_]+\?host=\/var\/run\/postgresql$/.test(DB)) { console.log("refusing: DB must be a local socket database"); process.exit(2); }

let oks = 0, fails = 0;
const results = [];
const rep = (name, cond, detail = "") => {
  if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); }
};
const admin = new Client({ connectionString: DB }); await admin.connect();
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];

// ------------------------------------------------------------------ fixtures (fictional people only)
const CLUB = await one("select id from clubs where slug = 'batroun'");
// a real (non-demo) club taking its fee online through a real provider name, so charges count as collected money
await q("alter database " + (await one("select current_database()")) + " set app.payment_provider = 'whish'");
await q("update clubs set is_demo = false, payment_mode = 'fee_online', service_fee_usd = 1, cancel_cutoff_hours = 6, max_upcoming_bookings = 20, hold_minutes = 10 where id = $1", [CLUB]);
const U = (n) => `ad000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PLAYERS = Array.from({ length: 30 }, (_, i) => U(i + 1));
const STAFF = [U(101), U(102)], ADMIN = U(200), CLOSER = U(300), CLOSER2 = U(301);
await q("insert into auth.users (id, phone) select x, '+9617160' || lpad(n::text, 4, '0') from unnest($1::uuid[]) with ordinality t(x, n) on conflict do nothing", [[...PLAYERS, ...STAFF, ADMIN, CLOSER, CLOSER2]]);
await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [[...PLAYERS, ...STAFF, ADMIN, CLOSER, CLOSER2]]);
await q("update profiles set roles = '{player,admin}' where id = $1", [ADMIN]);
await q("insert into club_staff (club_id, profile_id) select $1, x from unnest($2::uuid[]) x on conflict do nothing", [CLUB, STAFF]);
let courtN = 0;
const newCourt = async () => one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 960) returning id", [CLUB, `zz-adv-${++courtN}`]);
const at = async (hhmm, days = 3) => one(`select ((current_date + ${days})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hhmm]);

// ------------------------------------------------------------------ callers
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
const EXPECTED = new Set(["slot_taken", "hold_conflict", "hold_expired", "not_payable", "attempts_exhausted", "attempt_in_progress",
  "account_closed", "not_confirmed", "forbidden", "already_refunded", "refund_reference_used", "not_refund_due", "token_reused",
  "duplicate_provider_ref", "attempt_evidence_conflict", "charge_evidence_conflict", "not_found", "booking_started",
  "overlaps_existing_block", "block_overlaps_booking", "too_many_upcoming", "slot_unavailable", "fault_injected", "price_changed"]);
const classify = (e) => {
  const m = String(e?.message ?? e);
  if (EXPECTED.has(m)) return { refused: m };
  return { error: `${e?.code ?? "?"} ${m}` };
};
/** One caller per connection; every call sent at once; each commits as soon as its own call returns. */
async function herd(calls) {
  const sessions = await Promise.all(calls.map(([who]) => session(who)));
  return Promise.all(calls.map(async ([, sql, args], i) => {
    const c = sessions[i];
    try { const r = await c.query(sql, args); await c.query("commit"); return { rows: r.rows }; }
    catch (e) { await c.query("rollback").catch(() => {}); return classify(e); }
    finally { await c.end(); }
  }));
}
const call = async (who, sql, args = []) => (await herd([[who, sql, args]]))[0];
const errorsIn = (rs) => rs.filter((r) => r.error).map((r) => r.error);

// ------------------------------------------------------------------ building blocks
const HOLD = "select booking_id, payment_id, already from hold_slot($1, $2, $3, $4, $5)";
const hold = (who, court, s, e, token = null) => call(who, HOLD, [CLUB, court, s, e, token]);
const START = "select attempt_id, already from start_payment_attempt($1, $2)";
const RESULT = "select record_attempt_result($1, $2, $3, $4, $5) as r";
const succeed = (attempt, ref, amount = 1, cur = "USD") => call("service", RESULT, [attempt, "succeeded", ref, amount, cur]);
async function heldAndStarted(player, court, s, e) {
  const h = await hold(player, court, s, e, randomUUID());
  if (!h.rows) throw new Error(`hold failed: ${JSON.stringify(h)}`);
  const a = await call(player, START, [h.rows[0].payment_id, randomUUID()]);
  if (!a.rows) throw new Error(`start failed: ${JSON.stringify(a)}`);
  await call("service", "select open_payment_attempt($1, 'https://pay.invalid/x', 'sess')", [a.rows[0].attempt_id]);
  return { booking: h.rows[0].booking_id, payment: h.rows[0].payment_id, attempt: a.rows[0].attempt_id };
}
const bookingStatus = (id) => one("select status from bookings where id = $1", [id]);
const payment = async (id) => (await q("select status, kind, total_usd, provider_ref from payments where id = $1", [id]))[0];
const charges = async (paymentId) => q("select disposition, reason, amount, provider_ref from fee_charges where payment_id = $1 order by received_at", [paymentId]);
const backdateHold = (booking) => q("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [booking]);

// ------------------------------------------------------------------ global invariants (after every scenario)
async function invariants(label) {
  const v = {
    G1_overlap: await one(`select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id
      and a.status in ('pending','confirmed') and b.status in ('pending','confirmed') and tstzrange(a.start_at, a.end_at) && tstzrange(b.start_at, b.end_at)`),
    G2_paid_without_one_kept: await one(`select count(*) from payments p where p.kind = 'fee_only' and p.status = 'paid'
      and (select count(*) from fee_charges c where c.payment_id = p.id and c.disposition = 'kept') <> 1`),
    G3_kept_not_paid: await one(`select count(*) from fee_charges c join payments p on p.id = c.payment_id
      where c.disposition = 'kept' and p.status <> 'paid'`),
    G4_unauthorised_confirm: await one(`select count(*) from bookings b join clubs cl on cl.id = b.club_id
      where b.source = 'app' and b.status = 'confirmed' and b.fee_usd > 0 and cl.payment_mode = 'fee_online'
      and not exists (select 1 from payments p join fee_charges c on c.payment_id = p.id and c.disposition = 'kept'
                      where p.booking_id = b.id and p.status = 'paid')`),
    G5_paid_booking_not_settled: await one(`select count(*) from payments p join bookings b on b.id = p.booking_id
      where p.kind = 'fee_only' and p.status = 'paid' and b.status in ('pending','expired')`),
    G6_succeeded_attempt_charges: await one(`select count(*) from payment_attempts a where a.status = 'succeeded'
      and (select count(*) from fee_charges c where c.attempt_id = a.id and c.reason is distinct from 'extra_charge') <> 1`),
    G7_two_unresolved: await one(`select count(*) from (select payment_id from payment_attempts where status in ('starting','open')
      group by payment_id having count(*) > 1) x`),
    G8_unexplained_money: await one(`select count(*) from fee_charges c where not (
      (c.disposition = 'kept' and c.reason is null) or (c.disposition = 'refund_due' and c.reason is not null and c.refund_due_at is not null)
      or (c.disposition = 'refunded' and c.refund_reference is not null and c.refund_amount = c.amount))`),
    G9_refund_twice: await one(`select count(*) from (select provider, refund_reference from fee_charges where refund_reference is not null
      group by 1, 2 having count(*) > 1) x`),
  };
  const bad = Object.entries(v).filter(([, n]) => Number(n) !== 0);
  rep(`${label}: global invariants G1–G9`, bad.length === 0, Object.fromEntries(bad));
}
const record = (id, invariant, actual, pass) => { results.push({ id, invariant, actual, pass }); rep(`${id}: ${invariant}`, pass, actual); };

// ================================================================== S1 two players, one slot (×10 rounds)
{
  let bad = 0, errs = [];
  for (let i = 0; i < 10; i++) {
    const court = await newCourt(); const s = await at("10:00"), e = await at("11:00");
    const rs = await herd([[PLAYERS[0], HOLD, [CLUB, court, s, e, randomUUID()]], [PLAYERS[1], HOLD, [CLUB, court, s, e, randomUUID()]]]);
    errs.push(...errorsIn(rs));
    const n = Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [court]));
    if (n !== 1 || rs.filter((r) => r.rows).length !== 1) bad++;
  }
  record("S1", "two players on one slot: exactly one hold, the other slot_taken (10 rounds)", { bad, errs }, bad === 0 && errs.length === 0);
  await invariants("S1");
}

// ================================================================== S2 player hold vs desk walk-in (×10)
{
  let bad = 0, errs = [], wins = { player: 0, desk: 0 };
  for (let i = 0; i < 10; i++) {
    const court = await newCourt(); const s = await at("12:00"), e = await at("13:00");
    const rs = await herd([[PLAYERS[2], HOLD, [CLUB, court, s, e, randomUUID()]],
      [STAFF[0], "select staff_book($1, $2, $3, $4, 'Walk-in', null) as id", [CLUB, court, s, e]]]);
    errs.push(...errorsIn(rs));
    if (rs[0].rows) wins.player++; if (rs[1].rows) wins.desk++;
    const n = Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [court]));
    if (n !== 1 || rs.filter((r) => r.rows).length !== 1) bad++;
  }
  record("S2", "player hold vs desk walk-in: exactly one active booking (10 rounds)", { bad, errs, wins }, bad === 0 && errs.length === 0);
  await invariants("S2");
}

// ================================================================== S3 two desk walk-ins at once (×10)
{
  let bad = 0, errs = [];
  for (let i = 0; i < 10; i++) {
    const court = await newCourt(); const s = await at("14:00"), e = await at("15:00");
    const rs = await herd([[STAFF[0], "select staff_book($1, $2, $3, $4, 'A', null) as id", [CLUB, court, s, e]],
      [STAFF[1], "select staff_book($1, $2, $3, $4, 'B', null) as id", [CLUB, court, s, e]]]);
    errs.push(...errorsIn(rs));
    const n = Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [court]));
    if (n !== 1 || rs.filter((r) => r.rows).length !== 1) bad++;
  }
  record("S3", "two simultaneous desk walk-ins: exactly one (10 rounds)", { bad, errs }, bad === 0 && errs.length === 0);
  await invariants("S3");
}

// ================================================================== S4 an expiring hold vs its own payment (×10)
// Invariant: either the payment wins (booking confirmed, charge kept, the other player refused) or the other hold wins
// (first hold expired, the late charge recorded and owed back). Never both, never a lost charge.
{
  let bad = 0, errs = [], paths = { paid: 0, late: 0 };
  for (let i = 0; i < 10; i++) {
    const court = await newCourt(); const s = await at("16:00"), e = await at("17:00");
    const x = await heldAndStarted(PLAYERS[3], court, s, e);
    await backdateHold(x.booking);
    const ref = `s4-${randomUUID()}`;
    const rs = await herd([["service", RESULT, [x.attempt, "succeeded", ref, 1, "USD"]], [PLAYERS[4], HOLD, [CLUB, court, s, e, randomUUID()]]]);
    errs.push(...errorsIn(rs));
    const b = await bookingStatus(x.booking), p = await payment(x.payment), c = await charges(x.payment);
    const other = Number(await one("select count(*) from bookings where court_id = $1 and player_id = $2 and status = 'pending'", [court, PLAYERS[4]]));
    const okPaid = b === "confirmed" && p.status === "paid" && c.length === 1 && c[0].disposition === "kept" && other === 0;
    const okLate = b === "expired" && p.status === "refund_due" && c.length === 1 && c[0].disposition === "refund_due" && c[0].reason === "not_confirmed" && other === 1;
    if (okPaid) paths.paid++; else if (okLate) paths.late++; else bad++;
  }
  record("S4", "expiring hold vs its payment: paid-and-confirmed or late-and-owed-back, never both, never lost", { bad, errs, paths }, bad === 0 && errs.length === 0);
  await invariants("S4");
}

// ================================================================== S5 paying a hold whose slot another player took
{
  const court = await newCourt(); const s = await at("18:00"), e = await at("19:00");
  const x = await heldAndStarted(PLAYERS[5], court, s, e);
  await backdateHold(x.booking);
  const h2 = await hold(PLAYERS[6], court, s, e, randomUUID());
  const r = await succeed(x.attempt, `s5-${randomUUID()}`);
  const b = await bookingStatus(x.booking), p = await payment(x.payment), c = await charges(x.payment);
  record("S5", "late success after the slot was taken: not confirmed; charge recorded and owed back; the new hold untouched",
    { h2: !!h2.rows, r: r.rows?.[0]?.r ?? r, b, p: p.status, c },
    !!h2.rows && r.rows?.[0]?.r === "late" && b === "expired" && p.status === "refund_due" && c.length === 1 && c[0].disposition === "refund_due"
      && (await bookingStatus(h2.rows[0].booking_id)) === "pending");
  await invariants("S5");
}

// ================================================================== S6 money taken, booking cannot be confirmed
// A business refusal while confirming (here: a test trigger that refuses this one booking's confirmation, standing in
// for any future rule) must not lose the money: the attempt succeeds, the charge is recorded and owed back.
{
  const court = await newCourt(); const s = await at("20:00"), e = await at("21:00");
  const x = await heldAndStarted(PLAYERS[7], court, s, e);
  await q(`create or replace function zz_refuse_confirm() returns trigger language plpgsql as $$
    begin if new.id = '${x.booking}' and new.status = 'confirmed' then raise exception 'fault_injected'; end if; return new; end $$`);
  await q("create trigger zz_refuse_confirm before update on bookings for each row execute function zz_refuse_confirm()");
  const r = await succeed(x.attempt, `s6-${randomUUID()}`);
  await q("drop trigger zz_refuse_confirm on bookings"); await q("drop function zz_refuse_confirm()");
  const b = await bookingStatus(x.booking), p = await payment(x.payment), c = await charges(x.payment);
  const att = await one("select status || '/' || outcome from payment_attempts where id = $1", [x.attempt]);
  record("S6", "confirmation refused after money was taken: attempt succeeded/late, charge owed back, booking not confirmed, visible in the admin refund queue",
    { r: r.rows?.[0]?.r ?? r, b, p: p.status, c, att },
    r.rows?.[0]?.r === "late" && b === "pending" && p.status === "refund_due" && c.length === 1 && c[0].disposition === "refund_due" && att === "succeeded/late");
  const queue = await call(ADMIN, "select count(*)::int n from fee_refunds_due() where provider_ref = $1", [c[0]?.provider_ref]);
  rep("S6: the owed-back charge appears in the admin's fee refund queue", queue.rows?.[0]?.n === 1, queue);
  await invariants("S6");
}

// ================================================================== S7 lost answers: every step repeated
{
  const court = await newCourt(); const s = await at("10:00", 4), e = await at("11:00", 4);
  const token = randomUUID(), key = randomUUID();
  const h1 = await hold(PLAYERS[8], court, s, e, token), h2 = await hold(PLAYERS[8], court, s, e, token);
  const a1 = await call(PLAYERS[8], START, [h1.rows[0].payment_id, key]), a2 = await call(PLAYERS[8], START, [h1.rows[0].payment_id, key]);
  await call("service", "select open_payment_attempt($1, 'https://pay.invalid/x', 'sess')", [a1.rows[0].attempt_id]);
  const ref = `s7-${randomUUID()}`;
  const r1 = await succeed(a1.rows[0].attempt_id, ref), r2 = await succeed(a1.rows[0].attempt_id, ref);
  const nB = Number(await one("select count(*) from bookings where client_token = $1", [token]));
  const nA = Number(await one("select count(*) from payment_attempts where payment_id = $1", [h1.rows[0].payment_id]));
  const c = await charges(h1.rows[0].payment_id);
  record("S7", "hold, Pay and the result each sent twice: one booking, one attempt, one kept charge; second answers say 'already'",
    { h: [h1.rows[0].booking_id === h2.rows?.[0]?.booking_id, h2.rows?.[0]?.already], a: [a1.rows[0].attempt_id === a2.rows?.[0]?.attempt_id, a2.rows?.[0]?.already], r: [r1.rows?.[0]?.r, r2.rows?.[0]?.r], nB, nA, c: c.length },
    h1.rows[0].booking_id === h2.rows?.[0]?.booking_id && h2.rows[0].already === true && a1.rows[0].attempt_id === a2.rows?.[0]?.attempt_id
      && a2.rows[0].already === true && r1.rows?.[0]?.r === "confirmed" && r2.rows?.[0]?.r === "already_recorded" && nB === 1 && nA === 1 && c.length === 1);
  await invariants("S7");
}

// ================================================================== S8 the same success reported 12 times at once
{
  const court = await newCourt(); const s = await at("12:00", 4), e = await at("13:00", 4);
  const x = await heldAndStarted(PLAYERS[9], court, s, e);
  const ref = `s8-${randomUUID()}`;
  const rs = await herd(Array.from({ length: 12 }, () => ["service", RESULT, [x.attempt, "succeeded", ref, 1, "USD"]]));
  const answers = rs.map((r) => r.rows?.[0]?.r ?? r.refused ?? r.error);
  const c = await charges(x.payment);
  record("S8", "12 concurrent identical callbacks: one 'confirmed', the rest 'already_recorded'; one kept charge",
    { answers, c: c.length }, answers.filter((a) => a === "confirmed").length === 1 && answers.filter((a) => a === "already_recorded").length === 11
      && c.length === 1 && c[0].disposition === "kept" && (await bookingStatus(x.booking)) === "confirmed");
  // and a callback claiming a different reference for the same, already-paid attempt is refused, never added
  const forged = await succeed(x.attempt, `s8-other-${randomUUID()}`);
  record("S8b", "a later callback with a different charge for that attempt: refused (attempt_evidence_conflict), nothing added",
    { forged, c: (await charges(x.payment)).length }, forged.refused === "attempt_evidence_conflict" && (await charges(x.payment)).length === 1);
  await invariants("S8");
}

// ================================================================== S9 delayed and out-of-order answers
{
  const court = await newCourt(); const s = await at("14:00", 4), e = await at("15:00", 4);
  // (a) success, then a stale 'failed' and a stale 'pending'
  const x = await heldAndStarted(PLAYERS[10], court, s, e);
  await succeed(x.attempt, `s9a-${randomUUID()}`);
  const f = await call("service", RESULT, [x.attempt, "failed", null, null, null]);
  const pnd = await call("service", RESULT, [x.attempt, "pending", null, null, null]);
  const okA = f.rows?.[0]?.r === "ignored" && pnd.rows?.[0]?.r === "pending" && (await bookingStatus(x.booking)) === "confirmed"
    && (await one("select status from payment_attempts where id = $1", [x.attempt])) === "succeeded";
  record("S9a", "success then a stale 'failed'/'pending': the success stands, booking confirmed", { f: f.rows?.[0]?.r, pnd: pnd.rows?.[0]?.r }, okA);
  // (b) 'failed' first (e.g. the provider's page timed out), then the real success arrives while the hold still lives
  const court2 = await newCourt();
  const y = await heldAndStarted(PLAYERS[11], court2, s, e);
  await call("service", RESULT, [y.attempt, "failed", null, null, null]);
  const late = await succeed(y.attempt, `s9b-${randomUUID()}`);
  // 0098 (M1, Paul 26 Nov): a closed attempt is never revived; the money is recorded and owed back, the live hold stays
  const yc = await charges(y.payment);
  record("S9b", "'failed' then success (hold still live): money is not lost (recorded, owed back); the attempt is not revived; the hold stays pending (0098)",
    { late: late.rows?.[0]?.r ?? late, b: await bookingStatus(y.booking), c: yc },
    late.rows?.[0]?.r === "late" && (await bookingStatus(y.booking)) === "pending" && yc.length === 1 && yc[0].disposition === "refund_due");
  // (c) success for attempt 1 arrives after the player already paid with attempt 2 (two charges): the second is owed back
  const court3 = await newCourt();
  const z = await heldAndStarted(PLAYERS[12], court3, s, e);
  await call("service", RESULT, [z.attempt, "expired", null, null, null]);
  const a2 = await call(PLAYERS[12], START, [z.payment, randomUUID()]);
  await call("service", "select open_payment_attempt($1, 'https://pay.invalid/x', 'sess')", [a2.rows[0].attempt_id]);
  const r2 = await succeed(a2.rows[0].attempt_id, `s9c2-${randomUUID()}`);
  const r1 = await succeed(z.attempt, `s9c1-${randomUUID()}`);
  const c = await charges(z.payment);
  record("S9c", "attempt 1 reported paid after attempt 2 already paid: booking confirmed once, the first charge owed back as a duplicate",
    { r2: r2.rows?.[0]?.r, r1: r1.rows?.[0]?.r, c }, r2.rows?.[0]?.r === "confirmed" && r1.rows?.[0]?.r === "duplicate"
      && c.filter((k) => k.disposition === "kept").length === 1 && c.filter((k) => k.disposition === "refund_due" && k.reason === "duplicate").length === 1);
  await invariants("S9");
}

// ================================================================== S10 releasing a hold while its payment is confirmed (×10)
// Invariant: either released first (charge owed back, 'not_confirmed') or confirmed first (release refused: the
// booking is confirmed and paid). Money and booking always agree.
{
  let bad = 0, errs = [], paths = {};
  for (let i = 0; i < 10; i++) {
    const court = await newCourt(); const s = await at("16:00", 4), e = await at("17:00", 4);
    const x = await heldAndStarted(PLAYERS[13], court, s, e);
    const rs = await herd([["service", RESULT, [x.attempt, "succeeded", `s10-${randomUUID()}`, 1, "USD"]],
      [PLAYERS[13], "select release_hold($1) as r", [x.booking]]]);
    errs.push(...errorsIn(rs));
    const b = await bookingStatus(x.booking), p = await payment(x.payment), c = await charges(x.payment);
    const k = `${rs[0].rows?.[0]?.r ?? rs[0].refused}/${rs[1].rows ? "released" : rs[1].refused}/${b}/${p.status}/${c.map((x) => x.disposition).join(",")}`;
    paths[k] = (paths[k] ?? 0) + 1;
    const consistent = (b === "confirmed" && p.status === "paid" && c.length === 1 && c[0].disposition === "kept")
      || (["cancelled", "expired"].includes(b) && p.status === "refund_due" && c.length === 1 && c[0].disposition === "refund_due");
    if (!consistent) bad++;
  }
  record("S10", "release vs confirmation: booking and money always agree (confirmed+kept, or released+owed back)", { bad, errs, paths }, bad === 0 && errs.length === 0);
  // a player cancelling a CONFIRMED fee booking at the same time as a stale duplicate callback
  const court = await newCourt(); const s = await at("18:00", 4), e = await at("19:00", 4);
  const x = await heldAndStarted(PLAYERS[14], court, s, e); const ref = `s10b-${randomUUID()}`;
  await succeed(x.attempt, ref);
  const rs = await herd([["service", RESULT, [x.attempt, "succeeded", ref, 1, "USD"]], [PLAYERS[14], "select cancel_booking($1, false)", [x.booking]]]);
  const c = await charges(x.payment);
  record("S10b", "player cancels a paid booking while the same callback repeats: fee kept once (D1), nothing duplicated",
    { rs, b: await bookingStatus(x.booking), c }, errorsIn(rs).length === 0 && (await bookingStatus(x.booking)) === "cancelled" && c.length === 1 && c[0].disposition === "kept");
  await invariants("S10");
}

// ================================================================== S11 duplicate refund completions
{
  const court = await newCourt(); const s = await at("20:00", 4), e = await at("21:00", 4);
  const x = await heldAndStarted(PLAYERS[15], court, s, e);
  await succeed(x.attempt, `s11-${randomUUID()}`);
  const cc = await call(STAFF[0], "select cancel_booking($1, true)", [x.booking]);   // club-caused: fee owed back
  const charge = await one("select id from fee_charges where payment_id = $1", [x.payment]);
  const rs = await herd([
    ...Array.from({ length: 4 }, () => [ADMIN, "select complete_fee_refund($1, 1, 'provider_portal', 'RF-SAME') as r", [charge]]),
    [ADMIN, "select complete_fee_refund($1, 1, 'provider_portal', 'RF-OTHER') as r", [charge]],
    [STAFF[0], "select complete_fee_refund($1, 1, 'provider_portal', 'RF-STAFF') as r", [charge]],
    [PLAYERS[15], "select complete_fee_refund($1, 1, 'provider_portal', 'RF-PLAYER') as r", [charge]],
  ]);
  const answers = rs.map((r) => r.rows?.[0]?.r ?? r.refused ?? r.error);
  const row = (await q("select disposition, refund_reference, refund_amount from fee_charges where id = $1", [charge]))[0];
  const p = await payment(x.payment);
  record("S11", "7 concurrent refund completions (4 same ref, 1 other ref, staff, player): refunded exactly once; staff and player refused",
    { cc: cc.rows ? "ok" : cc, answers, row, p: p.status },
    !!cc.rows && row.disposition === "refunded" && answers.filter((a) => a === "refunded").length === 1
      && answers.slice(5).every((a) => a === "forbidden") && errorsIn(rs).length === 0 && p.status === "refunded"
      && (row.refund_reference === "RF-SAME" ? answers.slice(0, 4).filter((a) => a === "already_refunded").length === 3 && answers[4] === "already_refunded"
                                             : answers.slice(0, 4).every((a) => a === "already_refunded")));
  // a refund reference can settle only one charge
  const court2 = await newCourt();
  const y = await heldAndStarted(PLAYERS[16], court2, s, e);
  await succeed(y.attempt, `s11b-${randomUUID()}`);
  await call(STAFF[0], "select cancel_booking($1, true)", [y.booking]);
  const charge2 = await one("select id from fee_charges where payment_id = $1", [y.payment]);
  const reuse = await call(ADMIN, "select complete_fee_refund($1, 1, 'provider_portal', $2) as r", [charge2, row.refund_reference]);
  record("S11b", "the same provider refund reference used for a second charge: refused", reuse, reuse.refused === "refund_reference_used");
  // club staff cannot mark CourtBook's fee refunded through the club's own function
  const mr = await call(STAFF[0], "select mark_refunded($1)", [y.payment]);
  record("S11c", "club staff mark a fee-only refund through mark_refunded: refused", mr, mr.refused !== undefined || /courtbook_fee_refund/.test(mr.error ?? ""));
  await invariants("S11");
}

// ================================================================== S12 a staff move vs a new hold on the target slot (×10)
{
  let bad = 0, errs = [], wins = {};
  for (let i = 0; i < 10; i++) {
    const c1 = await newCourt(), c2 = await newCourt();
    const s = await at("10:00", 5), e = await at("11:00", 5);
    const walk = await call(STAFF[0], "select staff_book($1, $2, $3, $4, 'Mover', null) as id", [CLUB, c1, s, e]);
    const rs = await herd([[STAFF[1], "select move_booking($1, $2, $3, $4)", [walk.rows[0].id, c2, s, e]],
      [PLAYERS[17], HOLD, [CLUB, c2, s, e, randomUUID()]]]);
    errs.push(...errorsIn(rs));
    const n2 = Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [c2]));
    const where = await one("select court_id from bookings where id = $1", [walk.rows[0].id]);
    const k = `${rs[0].rows ? "moved" : rs[0].refused}/${rs[1].rows ? "held" : rs[1].refused}`;
    wins[k] = (wins[k] ?? 0) + 1;
    if (n2 !== 1 || (rs[0].rows && where !== c2) || (!rs[0].rows && where !== c1)) bad++;
  }
  record("S12", "staff move vs a new hold on the same target: exactly one occupies it; a refused move leaves the booking where it was", { bad, errs, wins }, bad === 0 && errs.length === 0);
  await invariants("S12");
}

// ================================================================== S13 extending a booking into an occupied slot
{
  const court = await newCourt();
  const a = await call(STAFF[0], "select staff_book($1, $2, $3, $4, 'First', null) as id", [CLUB, court, await at("12:00", 5), await at("13:00", 5)]);
  const b = await call(STAFF[0], "select staff_book($1, $2, $3, $4, 'Second', null) as id", [CLUB, court, await at("13:00", 5), await at("14:00", 5)]);
  const MOVE_PRICED = "select move_booking_priced($1, $2, $3, $4, (quote_move($1, $2, $3, $4)->>'new')::numeric)";
  const ext = await call(STAFF[0], MOVE_PRICED, [a.rows[0].id, court, await at("12:00", 5), await at("13:30", 5)]);
  const endA = await one("select end_at from bookings where id = $1", [a.rows[0].id]);
  record("S13", "extending into the next booking: refused; the booking keeps its original end", { ext, endA },
    !ext.rows && !ext.error && +new Date(endA) === +new Date(await at("13:00", 5)));
  // concurrent: two extensions racing into the same free half hour from both sides
  const court2 = await newCourt();
  const x = await call(STAFF[0], "select staff_book($1, $2, $3, $4, 'Left', null) as id", [CLUB, court2, await at("15:00", 5), await at("16:00", 5)]);
  const y = await call(STAFF[0], "select staff_book($1, $2, $3, $4, 'Right', null) as id", [CLUB, court2, await at("16:30", 5), await at("17:30", 5)]);
  const rs = await herd([[STAFF[0], MOVE_PRICED, [x.rows[0].id, court2, await at("15:00", 5), await at("16:30", 5)]],
    [STAFF[1], MOVE_PRICED, [y.rows[0].id, court2, await at("16:00", 5), await at("17:30", 5)]]]);
  record("S13b", "two extensions racing into the same free gap: exactly one succeeds", rs, rs.filter((r) => r.rows).length === 1 && errorsIn(rs).length === 0);
  await invariants("S13");
}

// ================================================================== S14 one reservation token sent 8 times at once
{
  const court = await newCourt(); const s = await at("18:00", 5), e = await at("19:00", 5);
  const token = randomUUID();
  const rs = await herd(Array.from({ length: 8 }, () => [PLAYERS[18], HOLD, [CLUB, court, s, e, token]]));
  const ids = new Set(rs.filter((r) => r.rows).map((r) => r.rows[0].booking_id));
  const n = Number(await one("select count(*) from bookings where client_token = $1", [token]));
  record("S14", "8 concurrent holds with one token: one booking; every answer that succeeds names it", { ids: ids.size, n, refused: rs.filter((r) => r.refused).map((r) => r.refused), errs: errorsIn(rs) },
    n === 1 && ids.size === 1 && errorsIn(rs).length === 0);
  // the same token on a different slot is refused, not a second booking
  const other = await hold(PLAYERS[18], court, await at("20:00", 5), await at("21:00", 5), token);
  record("S14b", "the same token for a different slot: refused (token_reused)", other, other.refused === "token_reused");
  // desk walk-ins have no token: two identical clicks are two attempts at the same slot, so one is refused
  await invariants("S14");
}

// ================================================================== S15 a database failure part way (fault injected)
{
  const court = await newCourt(); const s = await at("10:00", 6), e = await at("11:00", 6);
  const x = await heldAndStarted(PLAYERS[19], court, s, e);
  await q(`create or replace function zz_fail_charge() returns trigger language plpgsql as $$
    begin raise exception 'fault_injected'; end $$`);
  await q("create trigger zz_fail_charge before insert on fee_charges for each row execute function zz_fail_charge()");
  const r = await succeed(x.attempt, `s15-${randomUUID()}`);
  const mid = { b: await bookingStatus(x.booking), p: (await payment(x.payment)).status,
    a: await one("select status from payment_attempts where id = $1", [x.attempt]), c: (await charges(x.payment)).length };
  await q("drop trigger zz_fail_charge on fee_charges"); await q("drop function zz_fail_charge()");
  record("S15", "the charge insert fails: the whole result is undone (booking pending, payment pending, attempt open, no charge); the call says so",
    { r, mid }, r.refused === "fault_injected" && mid.b === "pending" && mid.p === "pending" && mid.a === "open" && mid.c === 0);
  const again = await succeed(x.attempt, `s15-retry-${randomUUID()}`);
  record("S15b", "after the fault clears, the same attempt is recorded normally (the sweeper/callback retry path)", again.rows?.[0]?.r ?? again, again.rows?.[0]?.r === "confirmed");
  // a fault inside hold_slot after the booking insert: no orphan booking without its payment
  const court2 = await newCourt();
  await q(`create or replace function zz_fail_payment() returns trigger language plpgsql as $$
    begin raise exception 'fault_injected'; end $$`);
  await q("create trigger zz_fail_payment before insert on payments for each row execute function zz_fail_payment()");
  const h = await hold(PLAYERS[20], court2, s, e, randomUUID());
  await q("drop trigger zz_fail_payment on payments"); await q("drop function zz_fail_payment()");
  const orphan = Number(await one("select count(*) from bookings where court_id = $1", [court2]));
  record("S15c", "the payment insert inside a hold fails: no booking is left behind", { h, orphan }, !h.rows && orphan === 0);
  await invariants("S15");
}

// ================================================================== S16 a closing account trying to book or pay
{
  const court = await newCourt(); const s = await at("12:00", 6), e = await at("13:00", 6);
  const x = await heldAndStarted(CLOSER, court, s, e);
  const closed = await call(CLOSER, "select close_my_account('web') as r");
  const newHold = await hold(CLOSER, await newCourt(), s, e, randomUUID());
  const pay = await call(CLOSER, START, [x.payment, randomUUID()]);
  const late = await succeed(x.attempt, `s16-${randomUUID()}`);
  const b = await bookingStatus(x.booking), p = await payment(x.payment), c = await charges(x.payment);
  record("S16", "after closing: a new hold refused, Pay refused, a success for the old attempt is owed back and never confirms",
    { closed: closed.rows ? "closed" : closed, newHold: newHold.refused ?? newHold.error ?? "held!", pay: pay.refused ?? pay.error ?? "started!", late: late.rows?.[0]?.r ?? late, b, p: p.status, c },
    !!closed.rows && !newHold.rows && !pay.rows && late.rows?.[0]?.r === "late" && b !== "confirmed" && c.length === 1 && c[0].disposition === "refund_due");
  // the attempt had ended before the closure: a new Pay must be refused by the closure itself, not by chance
  const court2 = await newCourt();
  const y = await heldAndStarted(CLOSER2, court2, s, e);
  await call("service", RESULT, [y.attempt, "failed", null, null, null]);
  await call(CLOSER2, "select close_my_account('web') as r");
  const pay2 = await call(CLOSER2, START, [y.payment, randomUUID()]);
  record("S16b", "after closing, with no attempt in progress: Pay refused because the account is closed", pay2, pay2.refused === "account_closed");
  await invariants("S16");
}

await admin.end();
console.log(`\n${oks} ok, ${fails} failed`);
console.log("RESULTS " + JSON.stringify(results.map(({ id, pass }) => [id, pass])));
process.exit(fails ? 1 : 0);
