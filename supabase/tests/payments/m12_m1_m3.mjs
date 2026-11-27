// M12 review M1–M3 (26 Nov): the six mandatory regression cases of the handover ("handover: M12 decisions M1–M3 and
// regression cases to the main session"), plus M3 and the unknown-timeout wording rule, on a scratch database migrated
// to 0098 with real roles and real concurrency (one connection per caller; concurrent calls released together by an
// advisory-lock barrier). Simulated provider answers only, given as the server routes give them (service_role).
// Fictional players only. LOCAL ONLY.
//   PSQL="sudo -u postgres psql" bash supabase/tests/payments/m12_m1_m3.sh        (CONTROL=1: without 0098, must fail)
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

// ------------------------------------------------------------------ extra building blocks
const RECONCILE = "select reconcile_provider_charge('whish', $1, $2, $3, $4) as r";
const reconcile = (attempt, ref, amount = 1, cur = "USD") => call("service", RECONCILE, [attempt, ref, amount, cur]);
// to_jsonb: also readable on a database without 0098's columns (CONTROL), where they are simply missing
const attemptRow = async (id) => (await q("select to_jsonb(a) j from payment_attempts a where id = $1", [id]))[0]?.j ?? {};
const backdate = (booking, minutes) => q("update bookings set hold_expires_at = now() - make_interval(mins => $2) where id = $1", [booking, minutes]);
// the court time passes (simulated): the slot triggers are bypassed for this one update only
async function intoThePast(booking, secondsAgo = 3600) {
  await q("begin"); await q("set local session_replication_role = replica");
  await q("update bookings set start_at = now() - make_interval(secs => $2), end_at = now() - make_interval(secs => $2) + interval '1 hour' where id = $1", [booking, secondsAgo]);
  await q("commit");
}
/** Every call on its own connection, all waiting on one advisory lock, then released together. */
const GATE = 424_270;
async function together(calls) {
  await q("select pg_advisory_lock($1)", [GATE]);
  const sessions = await Promise.all(calls.map(([who]) => session(who)));
  const runs = calls.map(async ([, sql, args], i) => {
    const c = sessions[i];
    try {
      await c.query("select pg_advisory_lock_shared($1)", [GATE]); await c.query("select pg_advisory_unlock_shared($1)", [GATE]);
      const r = await c.query(sql, args); await c.query("commit"); return { rows: r.rows };
    } catch (e) { await c.query("rollback").catch(() => {}); return classify(e); }
    finally { await c.end(); }
  });
  // release only once every caller is queued on the gate
  for (let i = 0; i < 200; i++) {
    const n = Number(await one("select count(*) from pg_locks where locktype = 'advisory' and objid = $1 and not granted", [GATE]));
    if (n >= calls.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const queued = Number(await one("select count(*) from pg_locks where locktype = 'advisory' and objid = $1 and not granted", [GATE]));
  await q("select pg_advisory_unlock($1)", [GATE]);
  return { rs: await Promise.all(runs), queued };
}
const r0 = (x) => x.rows?.[0]?.r ?? x;
let player = 0;
const nextPlayer = () => PLAYERS[player++ % PLAYERS.length];

// ================================================================== Case 1: late charge after the attempt expired, court still free
for (const via of ["reconcile", "callback"]) {
  const court = await newCourt(); const s = await at("10:00"), e = await at("11:00");
  const x = await heldAndStarted(nextPlayer(), court, s, e);
  await call("service", RESULT, [x.attempt, "expired", null, null, null]);
  await backdate(x.booking, 40);
  const ref = `c1-${via}-${randomUUID()}`;
  const r = via === "reconcile" ? await reconcile(x.attempt, ref) : await succeed(x.attempt, ref);
  const b = await bookingStatus(x.booking), p = await payment(x.payment), c = await charges(x.payment), a = await attemptRow(x.attempt);
  record(`C1-${via}`, `late charge after the attempt expired (court free), via ${via}: late; charge and payment owed back; the booking not confirmed, set expired`,
    { r: r0(r), b, p: p.status, c, a },
    r0(r) === "late" && b === "expired" && p.status === "refund_due" && c.length === 1 && c[0].disposition === "refund_due" && a.end_reason === "provider_expired");
}
await invariants("C1");

// ================================================================== Case 2: success after the court's start time (attempt still open)
for (const secs of [3600, 1]) {
  const court = await newCourt(); const s = await at("12:00"), e = await at("13:00");
  const x = await heldAndStarted(nextPlayer(), court, s, e);
  await intoThePast(x.booking, secs);
  const r = await succeed(x.attempt, `c2-${secs}-${randomUUID()}`);
  const b = await bookingStatus(x.booking), p = await payment(x.payment), c = await charges(x.payment);
  record(`C2-${secs}s`, `success ${secs === 1 ? "1 second" : "an hour"} after the court time began: never confirmed; charge owed back; booking expired`,
    { r: r0(r), b, p: p.status, c }, r0(r) === "late" && b === "expired" && p.status === "refund_due" && c.length === 1 && c[0].disposition === "refund_due");
}
await invariants("C2");

// ================================================================== Case 3: provider succeeded before expiry but reported it after (no provider time)
{
  // 3b: attempt still open at discovery, deadline passed, no provider time → refund obligation
  const court = await newCourt(); const s = await at("14:00"), e = await at("15:00");
  const x = await heldAndStarted(nextPlayer(), court, s, e);
  await backdate(x.booking, 1);
  const r = await succeed(x.attempt, `c3b-${randomUUID()}`);
  const b = await bookingStatus(x.booking), c = await charges(x.payment);
  record("C3b", "attempt open at discovery, hold deadline passed, no provider time: owed back, never confirmed on discovery time", { r: r0(r), b, c },
    r0(r) === "late" && b === "expired" && c.length === 1 && c[0].disposition === "refund_due");
  // 3c: the attempt was already closed → refund obligation (before the deadline too: the hold stays for another attempt)
  const court2 = await newCourt();
  const y = await heldAndStarted(nextPlayer(), court2, s, e);
  await call("service", RESULT, [y.attempt, "failed", null, null, null]);
  const r2 = await succeed(y.attempt, `c3c-${randomUUID()}`);
  const b2 = await bookingStatus(y.booking), p2 = await payment(y.payment), c2 = await charges(y.payment);
  record("C3c", "attempt already closed (failed) when the success arrives, hold still live: owed back; the attempt is not revived; the hold and its payment stay for another attempt",
    { r: r0(r2), b: b2, p: p2.status, c: c2 }, r0(r2) === "late" && b2 === "pending" && p2.status === "pending" && c2.length === 1 && c2[0].disposition === "refund_due");
  // … and the same hold can still be paid by a new attempt, which confirms (and keeps its own charge)
  const a2 = await call(PLAYERS[(player - 1) % PLAYERS.length], START, [y.payment, randomUUID()]);
  const r3 = a2.rows ? await succeed(a2.rows[0].attempt_id, `c3c2-${randomUUID()}`) : a2;
  const c3 = await charges(y.payment);
  record("C3c2", "… a second attempt on that live hold still pays it: confirmed, one kept charge, the late one still owed back",
    { start: a2.rows ? "ok" : a2, r: r0(r3), c: c3 },
    r0(r3) === "confirmed" && (await bookingStatus(y.booking)) === "confirmed" && c3.filter((z) => z.disposition === "kept").length === 1 && c3.filter((z) => z.disposition === "refund_due").length === 1);
  // 3d: discovered after the deadline (equivalent to a provider time after it): owed back
  const court4 = await newCourt();
  const z = await heldAndStarted(nextPlayer(), court4, s, e);
  await backdate(z.booking, 5);
  const r4 = await reconcile(z.attempt, `c3d-${randomUUID()}`);
  record("C3d", "charge found by reconciliation after the deadline: owed back", { r: r0(r4), c: await charges(z.payment) }, r0(r4) === "late" && (await charges(z.payment))[0]?.disposition === "refund_due");
  // 3e: the slot was retaken by another player before the late success: owed back; the other booking intact
  const court5 = await newCourt();
  const w = await heldAndStarted(nextPlayer(), court5, s, e);
  await backdate(w.booking, 2);
  const other = await hold(nextPlayer(), court5, s, e, randomUUID());
  const r5 = await succeed(w.attempt, `c3e-${randomUUID()}`);
  record("C3e", "slot retaken by another player before the late success: owed back; the other player's hold untouched",
    { other: other.rows ? "held" : other, r: r0(r5) },
    !!other.rows && r0(r5) === "late" && (await bookingStatus(other.rows[0].booking_id)) === "pending" && (await charges(w.payment))[0]?.disposition === "refund_due");
  // 3f: a provider time in the future is not an input at all (no provider time is accepted): nothing to skew. The
  // decision rests on CourtBook's state only — shown by C3b/C3d. Recorded as a structural fact:
  const sig = await one("select pg_get_function_identity_arguments('record_attempt_result(uuid,text,text,numeric,text)'::regprocedure)");
  record("C3f", "no provider timestamp is taken by record_attempt_result or reconcile_provider_charge (a skewed time cannot confirm)", sig,
    !/time/.test(String(sig)) && !/time/.test(String(await one("select pg_get_function_identity_arguments('reconcile_provider_charge(text,text,text,numeric,text)'::regprocedure)"))));
  // the deadline is the one the attempt started under: a hold extended later does not stretch it
  const court6 = await newCourt();
  const v = await heldAndStarted(nextPlayer(), court6, s, e);
  const hasDeadline = Number(await one("select count(*) from pg_attribute where attrelid = 'payment_attempts'::regclass and attname = 'hold_deadline'"));
  if (hasDeadline) await q("update payment_attempts set hold_deadline = now() - interval '1 minute' where id = $1", [v.attempt]);   // started under a deadline now passed
  await q("update bookings set hold_expires_at = now() + interval '30 minutes' where id = $1", [v.booking]);       // the hold was extended since
  const r6 = await succeed(v.attempt, `c3x-${randomUUID()}`);
  record("C3-deadline", "a hold extended after the attempt started does not stretch the attempt's deadline: owed back", { r: r0(r6), hasDeadline }, hasDeadline === 1 && r0(r6) === "late");
}
await invariants("C3");

// ================================================================== Case 4: callback and reconciliation at once (×10)
{
  let bad = 0, errs = [], notQueued = 0;
  for (let i = 0; i < 10; i++) {
    const court = await newCourt(); const s = await at("16:00"), e = await at("17:00");
    const x = await heldAndStarted(nextPlayer(), court, s, e);
    await call("service", RESULT, [x.attempt, "expired", null, null, null]);
    await backdate(x.booking, 40);
    const ref = `c4-${i}-${randomUUID()}`;
    const { rs, queued } = await together([["service", RESULT, [x.attempt, "succeeded", ref, 1, "USD"]], ["service", RECONCILE, [x.attempt, ref, 1, "USD"]]]);
    if (queued < 2) notQueued++;
    errs.push(...errorsIn(rs));
    const outs = rs.map(r0).sort();
    const c = await charges(x.payment);
    if (!(outs[0] === "already_recorded" && outs[1] === "late" && c.length === 1 && c[0].disposition === "refund_due" && (await bookingStatus(x.booking)) !== "confirmed")) bad++;
  }
  record("C4", "late charge via callback AND reconciliation at once (×10): exactly one charge, owed back; never confirmed; the second answers already_recorded; no deadlock",
    { bad, errs, notQueued }, bad === 0 && errs.length === 0 && notQueued === 0);
}
{
  // an in-time success via both at once → exactly one confirmed, one kept charge
  let bad = 0, errs = [];
  for (let i = 0; i < 10; i++) {
    const court = await newCourt(); const s = await at("18:00"), e = await at("19:00");
    const x = await heldAndStarted(nextPlayer(), court, s, e);
    const ref = `c4b-${i}-${randomUUID()}`;
    const { rs } = await together([["service", RESULT, [x.attempt, "succeeded", ref, 1, "USD"]], ["service", RECONCILE, [x.attempt, ref, 1, "USD"]]]);
    errs.push(...errorsIn(rs));
    const outs = rs.map(r0).sort(); const c = await charges(x.payment);
    if (!(outs[0] === "already_recorded" && outs[1] === "confirmed" && c.length === 1 && c[0].disposition === "kept" && (await bookingStatus(x.booking)) === "confirmed")) bad++;
  }
  record("C4b", "in-time success via callback and reconciliation at once (×10): one confirmed, one kept charge", { bad, errs }, bad === 0 && errs.length === 0);
}
{
  // a third actor: another player holds the same slot at the same moment (the first hold past its deadline)
  let bad = 0, errs = [];
  for (let i = 0; i < 10; i++) {
    const court = await newCourt(); const s = await at("20:00"), e = await at("21:00");
    const x = await heldAndStarted(nextPlayer(), court, s, e);
    await backdate(x.booking, 2);
    const ref = `c4c-${i}-${randomUUID()}`;
    const { rs } = await together([["service", RESULT, [x.attempt, "succeeded", ref, 1, "USD"]], ["service", RECONCILE, [x.attempt, ref, 1, "USD"]],
      [nextPlayer(), HOLD, [CLUB, court, s, e, randomUUID()]]]);
    errs.push(...errorsIn(rs));
    const live = Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [court]));
    const keptWithoutConfirmed = Number(await one(`select count(*) from fee_charges c join payments p on p.id = c.payment_id join bookings b on b.id = p.booking_id
      where c.disposition = 'kept' and b.status <> 'confirmed' and b.court_id = $1`, [court]));
    if (live > 1 || keptWithoutConfirmed > 0 || (await bookingStatus(x.booking)) === "confirmed") bad++;
  }
  record("C4c", "late success ×2 plus another player's hold at once (×10): at most one live booking; a kept charge only with a confirmed booking; the late one never confirmed",
    { bad, errs }, bad === 0 && errs.length === 0);
}
await invariants("C4");

// ================================================================== Case 5: release racing a successful payment
{
  // success, then release → already_confirmed; the booking stays confirmed and paid
  const court = await newCourt(); const s = await at("10:00", 4), e = await at("11:00", 4);
  const who = nextPlayer();
  const x = await heldAndStarted(who, court, s, e);
  await succeed(x.attempt, `c5a-${randomUUID()}`);
  const rel = await call(who, "select release_hold($1) as r", [x.booking]);
  record("C5a", "success, then the player releases: release_hold answers already_confirmed; the court stays booked and paid",
    { rel: r0(rel), b: await bookingStatus(x.booking), p: (await payment(x.payment)).status },
    r0(rel) === "already_confirmed" && (await bookingStatus(x.booking)) === "confirmed" && (await payment(x.payment)).status === "paid");
  // release, then success → released, then a refund obligation
  const court2 = await newCourt(); const who2 = nextPlayer();
  const y = await heldAndStarted(who2, court2, s, e);
  const rel2 = await call(who2, "select release_hold($1) as r", [y.booking]);
  const late = await succeed(y.attempt, `c5b-${randomUUID()}`);
  record("C5b", "release, then the success: released; the late success is owed back; the booking stays expired",
    { rel: r0(rel2), late: r0(late), b: await bookingStatus(y.booking), c: await charges(y.payment) },
    r0(rel2) === "released" && r0(late) === "late" && (await bookingStatus(y.booking)) === "expired" && (await charges(y.payment))[0]?.disposition === "refund_due");
  // releasing an already-closed hold → already_closed
  const rel3 = await call(who2, "select release_hold($1) as r", [y.booking]);
  record("C5c", "releasing a hold already ended: already_closed", r0(rel3), r0(rel3) === "already_closed");
  // concurrent ×10: each round is one of the two, and the player is told which
  let bad = 0, errs = [], paths = { released: 0, already_confirmed: 0 };
  for (let i = 0; i < 10; i++) {
    const c = await newCourt(); const w = nextPlayer();
    const z = await heldAndStarted(w, c, s, e);
    const { rs } = await together([["service", RESULT, [z.attempt, "succeeded", `c5d-${i}-${randomUUID()}`, 1, "USD"]], [w, "select release_hold($1) as r", [z.booking]]]);
    errs.push(...errorsIn(rs));
    const pay = r0(rs[0]), rel = r0(rs[1]); const b = await bookingStatus(z.booking); const ch = await charges(z.payment);
    if (rel === "already_confirmed" && pay === "confirmed" && b === "confirmed" && ch[0]?.disposition === "kept") paths.already_confirmed++;
    else if (rel === "released" && pay === "late" && b === "expired" && ch[0]?.disposition === "refund_due") paths.released++;
    else bad++;
  }
  record("C5d", "release vs success at once (×10): each round either confirmed (and the release says already_confirmed) or released (and the money owed back); never 'released' while booked",
    { bad, errs, paths }, bad === 0 && errs.length === 0);
}
await invariants("C5");

// ================================================================== Case 6: repeated reconciliation of a charge already owed back
{
  const court = await newCourt(); const s = await at("12:00", 4), e = await at("13:00", 4);
  const x = await heldAndStarted(nextPlayer(), court, s, e);
  await backdate(x.booking, 2);
  await hold(nextPlayer(), court, s, e, randomUUID());   // the hold was replaced
  const ref = `c6-${randomUUID()}`;
  const first = await reconcile(x.attempt, ref);
  const again = await reconcile(x.attempt, ref);
  const { rs: three } = await together([["service", RECONCILE, [x.attempt, ref, 1, "USD"]], ["service", RECONCILE, [x.attempt, ref, 1, "USD"]], ["service", RECONCILE, [x.attempt, ref, 1, "USD"]]]);
  const charge = await one("select id from fee_charges where provider_ref = $1", [ref]);
  const refund = await call(ADMIN, "select complete_fee_refund($1, 1, 'provider_portal', $2) as r", [charge, `RF-${randomUUID()}`]);
  const after = await reconcile(x.attempt, ref);
  const cb = await succeed(x.attempt, ref);
  const noRef = await call("service", RECONCILE, [null, ref, 1, "USD"]);
  const noRefOtherAmount = await call("service", RECONCILE, [null, ref, 2, "USD"]);
  const c = await charges(x.payment);
  record("C6", "late charge, then reconcile again, ×3 at once, refunded, reconcile again, the callback again, and without our reference: one charge, refunded once, never kept, booking never confirmed",
    { first: r0(first), again: r0(again), three: three.map(r0), refund: refund.rows ? "ok" : refund, after: r0(after), cb: r0(cb), noRef: r0(noRef), noRefOtherAmount, c },
    r0(first) === "late" && r0(again) === "already_recorded" && three.every((z) => r0(z) === "already_recorded") && !!refund.rows
      && r0(after) === "already_recorded" && r0(cb) === "already_recorded" && r0(noRef) === "already_recorded"
      && noRefOtherAmount.refused === "charge_evidence_conflict"
      && c.length === 1 && c[0].disposition === "refunded" && (await bookingStatus(x.booking)) !== "confirmed");
}
await invariants("C6");

// ================================================================== unknown timeout: recorded as such (wording rule)
{
  const court = await newCourt(); const s = await at("14:00", 4), e = await at("15:00", 4);
  const x = await heldAndStarted(nextPlayer(), court, s, e);
  const r = await call("service", RESULT, [x.attempt, "unknown_timeout", null, null, null]);
  const a = await attemptRow(x.attempt);
  record("U1", "the provider never knew the attempt (CourtBook's inference): attempt expired with reason unknown_timeout, distinct from the provider's own expiry",
    { r: r0(r), a }, r0(r) === "unknown_timeout" && a.status === "expired" && a.end_reason === "unknown_timeout");
  const court2 = await newCourt(); const who = nextPlayer();
  const h = await hold(who, court2, s, e, randomUUID());
  const st = await call(who, START, [h.rows[0].payment_id, randomUUID()]);       // 'starting': the provider was never reached
  const ab = await call("service", "select abandon_payment_attempt($1, 'gateway refused') as r", [st.rows[0].attempt_id]);
  const a2 = await attemptRow(st.rows[0].attempt_id);
  record("U2", "a provider that refused to start: failed, reason abandoned (never 'unknown')", { ab: r0(ab), a: a2 },
    r0(ab) === "failed" && a2.status === "failed" && a2.end_reason === "abandoned");
}

// ================================================================== M3: the club-caused refund obligation names its actor
{
  const court = await newCourt(); const s = await at("16:00", 4), e = await at("17:00", 4);
  const x = await heldAndStarted(nextPlayer(), court, s, e);
  await succeed(x.attempt, `m3-${randomUUID()}`);
  const cancel = await call(STAFF[0], "select cancel_booking($1, true) as r", [x.booking]);
  const row = (await q("select to_jsonb(c) j from fee_charges c where payment_id = $1", [x.payment]))[0]?.j ?? {};
  record("M3a", "a staff member's club-caused cancellation records that staff member and the time on the charge owed back",
    { cancel: cancel.rows ? "ok" : cancel, row }, !!cancel.rows && row.disposition === "refund_due" && row.reason === "club_cancelled" && row.club_cancel_by === STAFF[0] && !!row.club_cancel_at);
  // a player's own cancellation records nothing (the fee is kept, D1)
  const court2 = await newCourt(); const who = nextPlayer();
  const y = await heldAndStarted(who, court2, s, e);
  await succeed(y.attempt, `m3b-${randomUUID()}`);
  await call(who, "select cancel_booking($1, false) as r", [y.booking]);
  const row2 = (await q("select to_jsonb(c) j from fee_charges c where payment_id = $1", [y.payment]))[0]?.j ?? {};
  record("M3b", "a player's own cancellation records no actor (the fee is kept)", row2, row2.disposition === "kept" && row2.club_cancel_by === null && row2.club_cancel_at === null && "club_cancel_by" in row2);
  // nobody changes it through the API: players and staff have no update right; the server key is refused by the trigger
  const asStaff = await call(STAFF[0], "update fee_charges set club_cancel_by = null where payment_id = $1 returning 1", [x.payment]);
  const asService = await call("service", "update fee_charges set club_cancel_by = $2 where payment_id = $1 returning 1", [x.payment, STAFF[1]]);
  const asAdmin = await call(ADMIN, "update fee_charges set club_cancel_at = now() where payment_id = $1 returning 1", [x.payment]);
  record("M3c", "the record cannot be changed through the API (staff, admin: no right; server key: refused as immutable)",
    { asStaff, asService, asAdmin },
    String(asStaff.error ?? "").includes("permission denied") && String(asService.error ?? asService.refused ?? "").includes("club_cancel_record_immutable")
      && String(asAdmin.error ?? "").includes("permission denied"));
  // the admin reads it (the refund queue's table policy); a player does not
  const seenByAdmin = await call(ADMIN, "select count(*)::int n from fee_charges c where payment_id = $1 and to_jsonb(c) ->> 'club_cancel_by' is not null", [x.payment]);
  const seenByPlayer = await call(nextPlayer(), "select count(*)::int n from fee_charges where payment_id = $1", [x.payment]);
  record("M3d", "admins can read who cancelled; players cannot see the charge at all", { a: seenByAdmin.rows?.[0]?.n, p: seenByPlayer.rows?.[0]?.n },
    seenByAdmin.rows?.[0]?.n === 1 && seenByPlayer.rows?.[0]?.n === 0);
  // the staff member's account deleted: the record keeps the id (no foreign key; like the moderation log)
  const fk = await one("select count(*) from pg_constraint where conrelid = 'fee_charges'::regclass and contype = 'f' and conkey = array[(select attnum from pg_attribute where attrelid = 'fee_charges'::regclass and attname = 'club_cancel_by')]::int2[]");
  record("M3e", "no foreign key on club_cancel_by: deleting the staff member's account keeps the record", fk, Number(fk) === 0);
}
await invariants("M3");

await admin.end();
console.log(`\n${oks} ok, ${fails} failed`);
console.log("RESULTS " + JSON.stringify(results.map(({ id, pass }) => [id, pass])));
process.exit(fails ? 1 : 0);
