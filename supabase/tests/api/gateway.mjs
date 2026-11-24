// M12.2 preparation (with the review corrections of PR #36): the provider-independent payment design against the REAL database through Supabase's API
// (local PostgREST + supabase-js, players with their own tokens, the server with the service key), driven by a FAKE
// gateway (src/lib/payments/testing/fakeGateway.ts). The fake models generic gateway behaviours only — lost callbacks,
// pages that expire silently, starts that time out after or before the page exists, a gateway that never heard of a
// reference, second charges and foreign charges that only its own list shows, outages. It is not Whish.
// The reconciliation run is the website's own code (src/lib/payments/reconcile.ts), as the scheduled route runs it.
//   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && SCRIPT=gateway.mjs PSQL="sudo -u postgres psql" bash supabase/tests/api/journey.sh
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { API_DB, asService, asUser } from "./lib.mjs";
import { FakeGateway } from "../../../src/lib/payments/testing/fakeGateway.ts";
import { runPaymentReconciliation } from "../../../src/lib/payments/reconcile.ts";
import { UNKNOWN_GRACE_MINUTES } from "../../../src/lib/payments/attempts.ts";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);

let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); } };
const db = new Client({ connectionString: `postgresql:///${API_DB}?host=/var/run/postgresql` }); await db.connect();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];

// ------------------------------------------------------------------ fixtures
const U = (n) => `a2000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const players = Array.from({ length: 30 }, (_, i) => U(i + 1));
const ADMIN = U(99);
await q("insert into auth.users (id, phone) values ($1, '+96171209999') on conflict do nothing", [ADMIN]);
await q("update profiles set roles = '{player,admin}' where id = $1", [ADMIN]);
await q("insert into auth.users (id, phone) select x, '+9617120' || lpad(n::text, 4, '0') from unnest($1::uuid[]) with ordinality t(x, n) on conflict do nothing", [players]);
await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [players]);
const CLUB = await one("select id from clubs where slug = 'batroun'");
await q("update clubs set payment_mode = 'fee_online', service_fee_usd = 1, hold_minutes = 10, max_upcoming_bookings = 20 where id = $1", [CLUB]);
const service = asService();
const at = (d, hhmm) => one(`select (((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut')`, [hhmm]);
let courtN = 0, playerN = 0;
const newCourt = async () => {
  const id = await one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 960) returning id", [CLUB, `zz-gw-${++courtN}`]);
  await q("insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ($1, $2, 127, '00:00', '23:59', 25, 'gw')", [CLUB, id]);
  return id;
};

// one player, one hold, the attempt the pay route would make (start_payment_attempt as the player, then the gateway)
const gw = new FakeGateway(() => Date.now());
async function holdAndStart(mode = "ok", opts = {}) {
  const who = opts.who ?? players[playerN++];
  const p = asUser(who);
  const court = opts.court ?? await newCourt();
  const { data: h, error } = await p.rpc("hold_slot", { p_club: CLUB, p_court: court, p_start: await at(3, opts.start ?? "10:00"), p_end: await at(3, opts.end ?? "11:00"), p_token: randomUUID() });
  if (error) throw new Error(`hold: ${error.message}`);
  // the deployment's provider is the gateway (on a real deployment: app.payment_provider and PAYMENT_PROVIDER)
  await q("update payments set provider = 'whish' where id = $1", [h[0].payment_id]);
  const x = { who, p, court, booking: h[0].booking_id, payment: h[0].payment_id };
  return { ...x, ...(await startOn(x, mode)) };
}
async function startOn(x, mode = "ok") {
  const { data: a, error: e2 } = await x.p.rpc("start_payment_attempt", { p_payment: x.payment, p_request: randomUUID() });
  if (e2) throw new Error(`attempt: ${e2.message}`);
  const attempt = a[0].attempt_id;
  gw.nextStart.push(mode);
  let started = "ok";
  try {
    const s = await gw.startAttempt({ attemptId: attempt, amountUsd: Number(a[0].amount_usd), currency: "USD", description: "fee", returnUrl: "https://x.example/r", callbackUrl: "https://x.example/c" });
    await service.rpc("open_payment_attempt", { p_attempt: attempt, p_session_url: s.url, p_provider_session: s.session });
  } catch (err) {
    started = err.name === "PaymentStartRefused" ? "refused" : "uncertain";
    if (started === "refused") await service.rpc("abandon_payment_attempt", { p_attempt: attempt, p_note: "refused" });
  }
  return { attempt, started, attemptNo: a[0].attempt_no };
}
const state = async (x) => (await q(`select b.status as booking, p.status as payment, a.status as attempt, a.outcome, b.hold_expires_at < now() as hold_over,
  (select string_agg(disposition || coalesce(':' || reason, ''), ',' order by disposition, reason) from fee_charges c where c.payment_id = p.id) as charges
  from bookings b join payments p on p.booking_id = b.id join payment_attempts a on a.payment_id = p.id where a.id = $1`, [x.attempt]))[0];
// a few milliseconds first, so a charge taken just now lies inside the run's window [since, now)
const run = async (extra = {}) => { await new Promise((ok) => setTimeout(ok, 5)); return runPaymentReconciliation(service, extra.provider ?? gw, { minAgeSeconds: 0, ...extra }); };
const watermark = () => one("select reconciled_until from payment_reconciliation where provider = 'whish'");
/** Let time pass for real: everything in the database and at the gateway moves `minutes` into the past (hold deadlines,
 *  attempt ages, the watermark, pages and charges), while the database's own clock and the run's clock stay the same. */
async function elapse(minutes) {
  const i = `${minutes} minutes`;
  await q(`update payment_attempts set created_at = created_at - $1::interval`, [i]);
  await q(`update bookings set hold_expires_at = hold_expires_at - $1::interval where hold_expires_at is not null`, [i]);
  await q(`update payment_reconciliation set reconciled_until = reconciled_until - $1::interval`, [i]);
  gw.shiftBack(minutes * 60_000);
}
const HOLD = Number(await one("select hold_minutes from clubs where id = $1", [CLUB]));

// ------------------------------------------------------------------ the first runs catch up from nothing (48 h back, 24 h per run)
{
  const runs = [];
  for (let i = 0; i < 5; i++) { const r = await run(); runs.push(r.problems); if (!r.problems.length) break; }
  rep("G0 first ever runs: 48 h back, at most 24 h a run (each window starts 1 h before the watermark); 'behind' on every run until caught up, then a clean run",
    runs.length >= 2 && runs.slice(0, -1).every((p) => p.length === 1 && p[0] === "reconciliation_behind") && runs.at(-1).length === 0, runs);
}

// ------------------------------------------------------------------ scenarios
// G1 lost callback: the player paid, no callback ever came; the run finds it
{
  const x = await holdAndStart();
  gw.pay(x.attempt);
  const r = await run();
  const s = await state(x);
  rep("G1 paid, callback lost: the reconciliation run asks the gateway and the booking is confirmed", s.booking === "confirmed" && s.charges === "kept" && r.problems.length === 0, { s, r: r.problems });
  const again = await run();
  rep("G1 ...running again changes nothing (one charge)", (await state(x)).charges === "kept" && again.problems.length === 0, again.problems);
}
// G2 the start timed out AFTER the gateway created the page; the player paid it anyway
{
  const x = await holdAndStart("timeout_after_create");
  const before = await state(x);
  gw.pay(x.attempt);
  await run();
  const s = await state(x);
  rep("G2 start timed out after the page existed, then paid: the attempt stayed unresolved and the run confirms the booking",
    x.started === "uncertain" && before.attempt === "starting" && s.booking === "confirmed" && s.charges === "kept", { before, s });
}
// G3 (review of PR #36, realistic timing) the start never reached the gateway. The "unknown" grace (30 min) is longer
//    than the hold (10 min): the player can NOT pay again on that hold. The hold ends at its own deadline as usual, the
//    slot is free, and a NEW hold gets its own attempts at once; the old attempt is closed only after the grace.
{
  const x = await holdAndStart("timeout_before_create", { start: "12:00", end: "13:00" });
  await elapse(HOLD + 1);                                             // past the hold's deadline, inside the grace
  await run();
  const s1 = await state(x);
  const sameHold = await x.p.rpc("start_payment_attempt", { p_payment: x.payment, p_request: randomUUID() });
  const y = await holdAndStart("ok", { who: x.who, court: x.court, start: "12:00", end: "13:00" });   // the same slot again
  rep(`G3 a start the gateway never received: after the ${HOLD}-min hold the attempt is still unresolved (grace ${UNKNOWN_GRACE_MINUTES} min); no new attempt on that hold (hold_expired); the slot is free and a new hold's attempt starts at once`,
    s1.attempt === "starting" && s1.hold_over && /hold_expired/.test(sameHold.error?.message ?? "") && y.attemptNo === 1 && y.started === "ok",
    { s1, sameHold: sameHold.error?.message, y: y.attemptNo });
  await elapse(UNKNOWN_GRACE_MINUTES - HOLD);                         // now past the grace
  const r = await run();
  const s2 = await state(x);
  rep("G3 ...after the grace the run closes the old attempt as expired; nothing for a person", s2.attempt === "expired" && !r.problems.includes("overdue_attempts"), { s2, r: r.problems });
}
// G4 (realistic timing) the page expired silently before the hold did: the player CAN pay again on that hold
{
  const x = await holdAndStart();
  await elapse(gw.pageMinutes + 1);                                   // page gone, hold still live
  await run();
  const s = await state(x);
  const next = await startOn(x);
  rep(`G4 a ${gw.pageMinutes}-min page that expired with no notice is recorded as expired inside the ${HOLD}-min hold; attempt 2 starts on the same hold`,
    s.attempt === "expired" && s.booking === "pending" && !s.hold_over && next.attemptNo === 2, { s, next });
}
// G5 a second charge on the same page that only the gateway's list shows
{
  const x = await holdAndStart();
  gw.pay(x.attempt);
  gw.pay(x.attempt);                                  // the gateway let the page be paid twice
  const r = await run();
  const s = await state(x);
  rep("G5 a second charge only the gateway's own list shows: recorded as an extra charge owed back; booking confirmed once",
    s.booking === "confirmed" && s.charges === "kept,refund_due:extra_charge" && r.reconcile?.outcomes.extra_charge >= 1, { s, r: r.reconcile });
}
// G6 a charge whose reference is not ours
{
  const c = gw.foreignCharge(1, "USD", Date.now() - 60_000);
  await run();
  const row = (await q("select disposition, reason, payment_id from fee_charges where provider = 'whish' and provider_ref = $1", [c.providerRef]))[0];
  rep("G6 a charge with a reference that is not ours: recorded as unmatched, owed back", row?.disposition === "refund_due" && row?.reason === "unmatched" && row?.payment_id === null, row);
}
// G7 the gateway took a different amount
{
  const x = await holdAndStart();
  gw.pay(x.attempt, { amount: 0.75 });
  await run();
  const s = await state(x);
  rep("G7 the gateway took a different amount: recorded and owed back, the booking not confirmed", s.booking === "pending" && s.charges === "refund_due:wrong_amount", s);
}
// G8 the late success: the hold ended and another player took the slot before the payment was found
{
  const x = await holdAndStart();
  await elapse(HOLD + 1);
  const other = asUser(players[playerN++]);
  const taken = await other.rpc("hold_slot", { p_club: CLUB, p_court: x.court, p_start: await at(3, "10:00"), p_end: await at(3, "11:00"), p_token: randomUUID() });
  gw.pages.get(x.attempt).created = Date.now();      // the player kept the page open and paid it late (the page was still valid)
  gw.pay(x.attempt);
  await run();
  const s = await state(x);
  rep("G8 paid after the hold ended and the slot was taken: recorded and owed back; the slot keeps its one booking",
    !taken.error && s.booking === "expired" && s.charges === "refund_due:not_confirmed"
    && Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [x.court])) === 1, s);
}
// G9 the run and a callback at the same moment, and two runs at the same moment
{
  const x = await holdAndStart();
  gw.pay(x.attempt);
  const [r1, r2, cb] = await Promise.all([run(), run(),
    (async () => { const st = await gw.attemptStatus(x.attempt); return service.rpc("record_attempt_result", { p_attempt: x.attempt, p_result: "succeeded", p_provider_ref: st.evidence.providerRef, p_amount: st.evidence.amount, p_currency: st.evidence.currency }); })()]);
  const s = await state(x);
  rep("G9 two runs and a callback at once: confirmed once, one charge", s.booking === "confirmed" && s.charges === "kept" && !cb.error, { s, p: [r1.problems, r2.problems], cb: cb.error?.message });
}
// G10 outages: the status API and the list API down — nothing decided, problems reported, the watermark does not move
{
  const x = await holdAndStart();
  gw.pay(x.attempt);
  const w0 = await watermark();
  gw.statusDown = true; gw.listDown = true;
  const r = await run();
  const during = await state(x);
  const w1 = await watermark();
  gw.statusDown = false; gw.listDown = false;
  const r2 = await run();
  rep("G10 gateway outage: nothing decided, the run reports it and the watermark stays; once back, the next run confirms",
    during.attempt === "open" && r.problems.includes("sweep_failures") && r.problems.includes("charge_list") && String(w0) === String(w1)
    && (await state(x)).booking === "confirmed" && r2.problems.length === 0, { during, r: r.problems, r2: r2.problems });
}
// G11 a refused start ends the attempt at once, and the next one starts
{
  const x = await holdAndStart("refused");
  const s = await state(x);
  const next = await startOn(x);
  rep("G11 a start the gateway refused: attempt failed at once, the hold kept, attempt 2 starts", x.started === "refused" && s.attempt === "failed" && s.booking === "pending" && next.attemptNo === 2, { s, next });
  gw.pay(next.attempt); await run();
}

// ------------------------------------------------------------------ review of PR #36
// G12 (1) out of time budget: incomplete, a problem, the watermark not moved
{
  gw.foreignCharge(1, "USD", Date.now() - 30_000);
  const w0 = await watermark();
  const r = await run({ budgetMs: -1 });
  rep("G12 a run that runs out of its time budget is incomplete (a problem, never success) and does not move the watermark",
    r.problems.includes("incomplete") && String(await watermark()) === String(w0), r.problems);
  await run();
}
// G13 (2) the runner was down for three days: it catches up window by window; every run until then says it is behind
{
  await elapse(72 * 60);                                              // three days pass with no run
  const missed = gw.foreignCharge(1, "USD", Date.now() - 60 * 3_600_000);   // a charge taken while it was down
  const runs = [];
  for (let i = 0; i < 6; i++) { const r = await run(); runs.push(r.problems); if (!r.problems.length) break; }
  const row = (await q("select reason from fee_charges where provider = 'whish' and provider_ref = $1", [missed.providerRef]))[0];
  rep("G13 down for three days: the charge list is read from the watermark, one window a run; 'behind' until caught up; the missed charge is recorded",
    runs.length >= 3 && runs.slice(0, -1).every((p) => p.includes("reconciliation_behind")) && runs.at(-1).length === 0 && row?.reason === "unmatched", { runs, row });
}
// G14 (2) an attempt the gateway cannot answer about for over 48 h: still asked every run, and overdue = a problem
{
  const x = await holdAndStart();
  gw.statusDown = true;
  await elapse(49 * 60);
  const r = await run();
  const s = await state(x);
  gw.statusDown = false;
  gw.pages.get(x.attempt).created = Date.now();     // still payable at the gateway for this check
  gw.pay(x.attempt);
  const r2 = await run();
  rep("G14 an attempt unresolved for over 48 h is still swept (never dropped) and reported overdue; once answered, nothing is overdue",
    s.attempt === "open" && r.problems.includes("overdue_attempts") && (await state(x)).attempt === "succeeded" && !r2.problems.includes("overdue_attempts"),
    { s, r: r.problems, r2: r2.problems });
}
// G15 (2) contradictory evidence is kept as an issue and reported on every run until an admin resolves it
{
  const c = gw.foreignCharge(1, "USD", Date.now() - 20_000);
  await run();
  gw.restate(c.providerRef, { amount: 2 });                          // the gateway's list now says something else
  const r1 = await run({ overlapMinutes: 24 * 60 });                  // read the same window again: the conflict
  await elapse(90);
  await run();                                                        // still inside this run's window (1 h overlap)
  const r2 = await run();                                             // the conflicting charge is now out of the window
  const issue = (await q("select id, code, seen from payment_reconciliation_issues where provider_ref = $1", [c.providerRef]))[0];
  const staffTry = await asUser(players[0]).rpc("resolve_reconciliation_issue", { p_issue: issue?.id, p_resolution: "x" });
  const ok = await asUser(ADMIN).rpc("resolve_reconciliation_issue", { p_issue: issue?.id, p_resolution: "provider confirmed $1; corrected its report" });
  const r3 = await run();
  rep("G15 a conflict is kept as an issue: reported on every run (also once out of the window) until an admin resolves it; only an admin can",
    r1.problems.includes("conflicts") && r2.problems.includes("open_issues") && !r2.problems.includes("conflicts") && issue?.code === "charge_evidence_conflict"
    && /forbidden/.test(staffTry.error?.message ?? "") && ok.data === "resolved" && r3.problems.length === 0, { r1: r1.problems, r2: r2.problems, issue, r3: r3.problems });
}
// G16 (4) the runner configured for the wrong provider: real attempts it cannot ask about are a problem, never success
{
  const x = await holdAndStart();
  const sim = new FakeGateway(() => Date.now(), "simulated");
  const r = await run({ provider: sim });
  rep("G16 a runner configured for another provider (simulated) with real attempts waiting: provider_mismatch, the attempt not touched",
    r.problems.includes("provider_mismatch") && r.sweep.skipped >= 1 && (await state(x)).attempt === "open", { r: r.problems, skipped: r.sweep.skipped });
  gw.pay(x.attempt); await run();
}

// ------------------------------------------------------------------ invariants over the whole database
const inv = {
  primary: Number(await one(`select count(*) from payment_attempts a where (a.status = 'succeeded') <> ((select count(*) from fee_charges c where c.attempt_id = a.id and c.reason is distinct from 'extra_charge') = 1)`)),
  kept: Number(await one(`select count(*) from payments p where p.kind = 'fee_only' and (p.status = 'paid') <> ((select count(*) from fee_charges c where c.payment_id = p.id and c.disposition = 'kept') = 1)`)),
  gwCharges: Number(await one("select count(*) from fee_charges where provider = 'whish'")),
  overlap: Number(await one(`select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period`)),
};
const gatewayCharges = [...gw.pages.values()].reduce((n, p) => n + p.charges.length, 0) + gw.foreign.length;
rep("I every charge the gateway ever took is recorded exactly once; every paid fee has one kept charge; no slot double-booked",
  inv.primary === 0 && inv.kept === 0 && inv.gwCharges === gatewayCharges && inv.overlap === 0, { ...inv, gatewayCharges });

console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
await db.end();
process.exit(fails ? 1 : 0);
