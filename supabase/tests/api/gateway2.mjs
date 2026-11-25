// M12.3 operational reconciliation against the REAL database through Supabase's API (local PostgREST + supabase-js,
// players with their own tokens, the server with the service key), driven by the FAKE gateway (generic behaviours,
// not Whish) — the same setup as gateway.mjs, with the scenarios of the M12.3 assignment:
//   R1 24-hour outage   R2 seven-day outage        R3 large backlog            R4 attempts the provider cannot answer for
//   R5 duplicate runs   R6 run interrupted halfway R7 charges listed late      R8 several records for one payment
//   R9 watermark rewind R10 provider without a list R11 malformed answers through the contract (guard.ts)
// LOCAL ONLY. Run: PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && SCRIPT=gateway2.mjs PSQL="sudo -u postgres psql" bash supabase/tests/api/journey.sh
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { API_DB, asService, asUser } from "./lib.mjs";
import { FakeGateway } from "../../../src/lib/payments/testing/fakeGateway.ts";
import { runPaymentReconciliation, reconcileCharges } from "../../../src/lib/payments/reconcile.ts";
import { guardProvider } from "../../../src/lib/payments/guard.ts";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);

let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); } };
const db = new Client({ connectionString: `postgresql:///${API_DB}?host=/var/run/postgresql` }); await db.connect();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];

// ------------------------------------------------------------------ fixtures
const U = (n) => `a3000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const players = Array.from({ length: 160 }, (_, i) => U(i + 1));
const ADMIN = U(999);
await q("insert into auth.users (id, phone) values ($1, '+96171309999') on conflict do nothing", [ADMIN]);
await q("update profiles set roles = '{player,admin}' where id = $1", [ADMIN]);
await q("insert into auth.users (id, phone) select x, '+961713' || lpad(n::text, 5, '0') from unnest($1::uuid[]) with ordinality t(x, n) on conflict do nothing", [players]);
await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [players]);
const CLUB = await one("select id from clubs where slug = 'batroun'");
await q("update clubs set payment_mode = 'fee_online', service_fee_usd = 1, hold_minutes = 10, max_upcoming_bookings = 20 where id = $1", [CLUB]);
const service = asService();
const admin = asUser(ADMIN);
const at = (d, hhmm) => one(`select (((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut')`, [hhmm]);
let courtN = 0, playerN = 0;
const newCourt = async () => {
  const id = await one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 960) returning id", [CLUB, `zz-gw2-${++courtN}`]);
  await q("insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ($1, $2, 127, '00:00', '23:59', 25, 'gw2')", [CLUB, id]);
  return id;
};
const gw = new FakeGateway(() => Date.now());
/** A player's hold and the attempt the pay route would make (as gateway.mjs does). */
async function holdAndStart(opts = {}) {
  const who = players[playerN++];
  const p = asUser(who);
  const court = opts.court ?? await newCourt();
  const { data: h, error } = await p.rpc("hold_slot", { p_club: CLUB, p_court: court, p_start: await at(3, opts.start ?? "10:00"), p_end: await at(3, opts.end ?? "11:00"), p_token: randomUUID() });
  if (error) throw new Error(`hold: ${error.message}`);
  await q("update payments set provider = 'whish' where id = $1", [h[0].payment_id]);
  const { data: a, error: e2 } = await p.rpc("start_payment_attempt", { p_payment: h[0].payment_id, p_request: randomUUID() });
  if (e2) throw new Error(`attempt: ${e2.message}`);
  const attempt = a[0].attempt_id;
  const s = await gw.startAttempt({ attemptId: attempt, amountUsd: 1, currency: "USD", description: "fee", returnUrl: "https://x.example/r", callbackUrl: "https://x.example/c" });
  await service.rpc("open_payment_attempt", { p_attempt: attempt, p_session_url: s.url, p_provider_session: s.session });
  return { who, p, court, booking: h[0].booking_id, payment: h[0].payment_id, attempt };
}
const st = async (x) => (await q(`select b.status as booking, a.status as attempt, a.outcome,
  (select count(*)::int from fee_charges c where c.payment_id = $2) as charges
  from bookings b, payment_attempts a where b.id = $1 and a.id = $3`, [x.booking, x.payment, x.attempt]))[0];
const run = async (extra = {}) => { await new Promise((ok) => setTimeout(ok, 5)); return runPaymentReconciliation(service, extra.provider ?? gw, { minAgeSeconds: 0, ...extra }); };
const watermark = async () => (await one("select reconciled_until from payment_reconciliation where provider = 'whish'"))?.getTime?.() ?? null;
/** Time passes: database timestamps and the gateway move `minutes` into the past together (as gateway.mjs). */
async function elapse(minutes) {
  const i = `${minutes} minutes`;
  await q(`update payment_attempts set created_at = created_at - $1::interval`, [i]);
  await q(`update bookings set hold_expires_at = hold_expires_at - $1::interval where hold_expires_at is not null`, [i]);
  await q(`update payment_reconciliation set reconciled_until = reconciled_until - $1::interval`, [i]);
  gw.shiftBack(minutes * 60_000);
}
const chargesOf = (ref) => one("select count(*)::int from fee_charges where provider = 'whish' and provider_ref = $1", [ref]);
/** Run until a run is clean (or n runs); returns every run's problems. */
async function runUntilClean(n, extra = {}) { const out = []; for (let i = 0; i < n; i++) { const r = await run(extra); out.push(r.problems); if (!r.problems.length) break; } return out; }

// the reconciliation starting point, set by a person (0094: never a default): now
{
  const r = await service.rpc("initialise_reconciliation_watermark", { p_provider: "whish", p_from: new Date(Date.now() - 60_000).toISOString() });
  if (r.error) throw new Error(`init: ${r.error.message}`);
  const first = await runUntilClean(3);
  rep("R0 starting point set by the operator (service role); a run with nothing to do is clean", first.at(-1).length === 0, first);
}

// ------------------------------------------------------------------ R1 the provider unavailable for 24 hours
{
  const paid = await holdAndStart();
  gw.pay(paid.attempt);                                           // money taken; the callback is lost
  const foreign = gw.foreignCharge(1, "USD");
  gw.statusDown = true; gw.listDown = true;
  const wm0 = await watermark();
  const during = [];
  for (let h = 0; h < 24; h += 6) { await elapse(360); const r = await run(); during.push(r.problems); }
  const s1 = await st(paid);
  const wm1 = await watermark();
  rep("R1 24 h outage: every run reports it (never success); nothing decided — the attempt neither failed nor confirmed; the watermark never moved",
    during.every((p) => p.includes("charge_list") && p.includes("sweep_failures")) && s1.attempt === "open" && s1.charges === 0
    && wm1 === wm0 - 24 * 3_600_000, { during, s1, wm0, wm1 });
  gw.statusDown = false; gw.listDown = false;
  const after = await runUntilClean(6);
  const s2 = await st(paid);
  rep("R1 ...once back: the paid attempt is recorded (late: its hold ended long ago — owed back), the foreign charge recorded, each once; runs 'behind' until caught up, then clean",
    s2.attempt === "succeeded" && s2.charges === 1 && (await chargesOf(foreign.providerRef)) === 1 && after.at(-1).length === 0
    && after.slice(0, -1).every((p) => p.length > 0), { s2, after });
}

// ------------------------------------------------------------------ R2 the provider unavailable for seven days
{
  const paid = await holdAndStart();
  gw.pay(paid.attempt);
  const daily = [];
  gw.statusDown = true; gw.listDown = true;
  const during = [];
  for (let d = 0; d < 7; d++) { daily.push(gw.foreignCharge(1, "USD")); await elapse(24 * 60); during.push((await run()).problems); }
  rep("R2 7-day outage: every daily run reports the outage; after 48 h the unanswered attempt is also reported overdue",
    during.every((p) => p.includes("charge_list")) && during.slice(2).every((p) => p.includes("overdue_attempts")), during);
  gw.statusDown = false; gw.listDown = false;
  const after = await runUntilClean(12);
  const recorded = await Promise.all(daily.map((c) => chargesOf(c.providerRef)));
  rep("R2 ...once back: caught up window by window (one 24 h window per run, 'behind' until done), every one of the 7 charges recorded exactly once, then clean",
    recorded.every((n) => n === 1) && after.length >= 8 && after.slice(0, -1).every((p) => p.includes("reconciliation_behind")) && after.at(-1).length === 0
    && (await st(paid)).charges === 1, { recorded, runs: after.length, last: after.at(-1) });
}

// ------------------------------------------------------------------ R3 a large backlog of unresolved attempts
{
  // 60 open attempts nobody has paid yet (so the charge list cannot settle them: only the sweep looks at them)
  const many = [];
  for (let i = 0; i < 60; i++) many.push(await holdAndStart());
  const ids = many.map((x) => x.attempt);
  const checked = async () => Number(await one("select count(*) from payment_attempts where id = any($1::uuid[]) and checks > 0", [ids]));
  const r1 = await run({ limit: 25 });
  rep("R3 backlog of 60 with 25 per run: the first run asks about 25 and says the run is NOT complete (sweep_backlog) — never a clean success",
    r1.sweep.checked === 25 && r1.problems.includes("sweep_backlog") && (await checked()) === 25, { sweep: r1.sweep, problems: r1.problems });
  const more = [];
  for (let i = 0; i < 2; i++) more.push((await run({ limit: 25 })).problems);
  rep("R3 ...two more runs reach every one of the 60 (least recently checked first), still reporting the backlog while more wait than one run handles",
    (await checked()) === 60 && more.every((p) => p.includes("sweep_backlog")), { checked: await checked(), more });
  for (const x of many) gw.pay(x.attempt);
  const rest = await runUntilClean(6, { limit: 25 });
  rep("R3 ...once all are paid: recorded once each, then a clean run",
    Number(await one("select count(*) from fee_charges where attempt_id = any($1::uuid[])", [ids])) === 60 && rest.at(-1).length === 0, rest);
}

// ------------------------------------------------------------------ R4 attempts the provider cannot answer for
{
  const stuck = [];
  for (let i = 0; i < 12; i++) stuck.push(await holdAndStart());
  for (const x of stuck) gw.statusFailFor.add(x.attempt);
  // 4 more, unpaid (so only the sweep can look at them), checked more recently than the stuck ones
  const ok = [];
  for (let i = 0; i < 4; i++) ok.push(await holdAndStart());
  await q("update payment_attempts set last_checked_at = null where id = any($1::uuid[])", [stuck.map((x) => x.attempt)]);
  await q("update payment_attempts set last_checked_at = now(), checks = 0 where id = any($1::uuid[])", [ok.map((x) => x.attempt)]);
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push((await run({ limit: 10 })).problems);
  const asked = Number(await one("select count(*) from payment_attempts where id = any($1::uuid[]) and checks > 0", [ok.map((x) => x.attempt)]));
  rep("R4 12 attempts the provider always fails on, 10 asked about per run: within 3 runs the queue still reaches the other 4 (an unanswered check counts as a check, so the same 10 are not picked for ever); the failures are reported every run",
    asked === 4 && runs.every((p) => p.includes("sweep_failures")), { asked, runs });
  for (const x of stuck) gw.statusFailFor.delete(x.attempt);
  for (const x of [...stuck, ...ok]) gw.pay(x.attempt);
  await runUntilClean(8, { limit: 25 });
}

// ------------------------------------------------------------------ R5 duplicate scheduled runs at the same time
{
  const xs = [];
  for (let i = 0; i < 8; i++) { const x = await holdAndStart(); gw.pay(x.attempt); xs.push(x); }
  const extra = gw.pay(xs[0].attempt);                                // a second charge only the list shows
  const foreigns = [gw.foreignCharge(1), gw.foreignCharge(2, "USD"), gw.foreignCharge(1, "EUR")];
  const runs = await Promise.all([run(), run(), run(), run()]);
  const errors = runs.flatMap((r) => r.problems.filter((p) => !["conflicts", "reconciliation_behind"].includes(p)));
  const counts = await Promise.all([extra, ...foreigns].map((c) => chargesOf(c.providerRef)));
  const kept = await Promise.all(xs.map((x) => one("select count(*)::int from fee_charges where attempt_id = $1 and disposition = 'kept'", [x.attempt])));
  const after = await runUntilClean(3);
  rep("R5 four runs at once: every charge recorded exactly once, each paid booking confirmed with one kept charge, no failure beyond normal reporting; the next run is clean",
    counts.every((n) => n === 1) && kept.every((n) => n === 1) && errors.length === 0 && after.at(-1).length === 0, { counts, kept, errors, after });
}

// ------------------------------------------------------------------ R6 a run interrupted halfway through its window
{
  const cs = Array.from({ length: 10 }, (_, i) => gw.foreignCharge(1 + (i % 3)));
  const since = new Date(Date.now() - 3_600_000), until = new Date();
  const list = await gw.listCharges(since, until);
  await reconcileCharges(service, gw, list.slice(0, 5));               // the process died here: no watermark move
  const after = await runUntilClean(3);
  const counts = await Promise.all(cs.map((c) => chargesOf(c.providerRef)));
  rep("R6 a run that died after half its window: the next run reads the window again; each charge recorded once (the first half not twice)",
    counts.every((n) => n === 1) && after.at(-1).length === 0, { counts, after });
}

// ------------------------------------------------------------------ R7 a charge that reaches the provider's list late
{
  gw.listDelayMs = 40 * 60_000;                                       // within the 60-minute overlap
  const c = gw.foreignCharge(1);
  const r1 = await run();                                             // not listed yet: the window still moves
  const first = await chargesOf(c.providerRef);
  await elapse(45);
  await runUntilClean(3);
  const later = await chargesOf(c.providerRef);
  rep("R7 a charge listed 40 min after it was taken (overlap 60 min): not seen by the first run, found by a later one, recorded once",
    first === 0 && later === 1, { first, later, r1: r1.problems });
  // beyond the overlap: the run cannot see it. This is the documented dependency on the provider's verified listing
  // delay (RECONCILE_DEFAULTS.overlapMinutes must exceed it). Shown, not hidden.
  gw.listDelayMs = 90 * 60_000;
  const d = gw.foreignCharge(1);
  for (let i = 0; i < 4; i++) { await run(); await elapse(30); }
  await runUntilClean(3);
  const missed = await chargesOf(d.providerRef);
  rep("R7b LIMIT a charge listed 90 min late (more than the 60-min overlap) is never read by the list — the overlap must exceed the provider's verified delay (needs Whish documentation)",
    missed === 0, { missed });
  // ...unless its attempt is still unresolved: the sweep asks about the attempt itself
  const x = await holdAndStart(); gw.pay(x.attempt);
  for (let i = 0; i < 2; i++) { await run(); await elapse(30); }
  rep("R7c a late-listed charge for one of OUR unresolved attempts is still found, by asking about the attempt", (await st(x)).charges === 1, await st(x));
  gw.listDelayMs = 0;
}

// ------------------------------------------------------------------ R8 several provider records against one payment
{
  const x = await holdAndStart();
  const c1 = gw.pay(x.attempt);
  await run();
  const c2 = gw.pay(x.attempt);                                        // charged again on the same page
  const c3 = gw.pay(x.attempt, { amount: 2 });                         // and once more, for another amount
  await runUntilClean(3);
  const rows = await q("select provider_ref, disposition, coalesce(reason, '-') as reason from fee_charges where payment_id = $1 order by received_at, provider_ref", [x.payment]);
  const by = Object.fromEntries(rows.map((r) => [r.provider_ref, `${r.disposition}:${r.reason}`]));
  rep("R8 three provider records for one payment: the first kept (booking confirmed once), the other two recorded and owed back as extra charges",
    by[c1.providerRef] === "kept:-" && by[c2.providerRef] === "refund_due:extra_charge" && by[c3.providerRef] === "refund_due:extra_charge"
    && rows.length === 3 && (await st(x)).booking === "confirmed", by);
  gw.restate(c1.providerRef, { amount: 3 });                          // the provider now reports the kept charge differently
  const r = await run();
  rep("R8b the provider contradicts the kept charge: a conflict for a person, nothing changed in the ledger",
    r.problems.includes("conflicts") && (await one("select amount from fee_charges where provider_ref = $1", [c1.providerRef])) == 1, r.problems);
  gw.restate(c1.providerRef, { amount: 1 });
  const issue = await one("select id from payment_reconciliation_issues where provider_ref = $1 and resolved_at is null", [c1.providerRef]);
  const res = await admin.rpc("resolve_reconciliation_issue", { p_issue: issue, p_resolution: "checked with the provider: amount 1" });
  if (res.error) throw new Error(`resolve: ${res.error.message}`);
  await runUntilClean(3);
}

// ------------------------------------------------------------------ R9 watermark: a person rewinds it
{
  const before = await watermark();
  const c = gw.foreignCharge(1);
  await runUntilClean(3);
  const to = new Date(Date.now() - 6 * 3_600_000).toISOString();
  const player = await asUser(players[0]).rpc("rewind_reconciliation_watermark", { p_provider: "whish", p_to: to });
  const adm = await admin.rpc("rewind_reconciliation_watermark", { p_provider: "whish", p_to: to });
  const rw = await service.rpc("rewind_reconciliation_watermark", { p_provider: "whish", p_to: to });
  const runs = await runUntilClean(4);
  rep("R9 only the operator (service role) can rewind — not a player, not an admin account; after a rewind the window is read again: nothing recorded twice, then clean",
    !!player.error && !!adm.error && !rw.error && (await chargesOf(c.providerRef)) === 1 && runs.at(-1).length === 0 && (await watermark()) >= before, { player: player.error?.message, rw: rw.error?.message, runs });
}

// ------------------------------------------------------------------ R10 a provider with no transaction list
{
  const noList = { name: "whish", startAttempt: gw.startAttempt.bind(gw), attemptStatus: gw.attemptStatus.bind(gw), start: gw.start, verify: gw.verify, refund: gw.refund };
  const x = await holdAndStart(); gw.pay(x.attempt);
  const c = gw.foreignCharge(1);
  const r = await run({ provider: noList });
  rep("R10 no charge list: the run says so on every run (coverage attempts_only) — our attempts are still settled by asking; a charge with no attempt cannot be found",
    r.coverage === "attempts_only" && (await st(x)).charges === 1 && (await chargesOf(c.providerRef)) === 0 && r.window === null, { coverage: r.coverage, problems: r.problems });
  await runUntilClean(3);                                             // the full runner picks the foreign charge up
}

// ------------------------------------------------------------------ R11 malformed answers, through the provider contract
{
  // status only (no charge list), so that nothing but the malformed answers can settle the attempt
  const statusOnly = guardProvider({ name: "whish", startAttempt: (i) => gw.startAttempt(i), attemptStatus: (id) => gw.attemptStatus(id), start: gw.start, verify: gw.verify, refund: gw.refund },
    { statusTimeoutMs: 200 });
  const x = await holdAndStart(); gw.pay(x.attempt);
  const failures = [];
  for (const bad of [{ state: "paid" }, { state: "succeeded", evidence: { providerRef: "G-x", amount: "1.00", currency: "USD" } },
    { state: "succeeded", evidence: { providerRef: "G-x", amount: 1, currency: "dollars" } }, "<html>502</html>"]) {
    gw.statusAnswer.set(x.attempt, bad);
    failures.push((await run({ provider: statusOnly })).sweep.failures.provider_unavailable ?? 0);
  }
  const s = await st(x);
  rep("R11 four malformed status answers (an unknown state, a string amount, a bad currency, an error page): each counted as 'provider unavailable'; nothing recorded, the attempt still open — never paid, never failed",
    s.attempt === "open" && s.charges === 0 && failures.every((n) => n === 1), { s, failures });
  gw.statusAnswer.delete(x.attempt);
  await runUntilClean(3, { provider: statusOnly });
  rep("R11b ...with a valid answer again, the same attempt is confirmed through the contract, once", (await st(x)).charges === 1 && (await st(x)).attempt === "succeeded", await st(x));

  const wm = await watermark();
  const c = gw.foreignCharge(1);
  const badList = guardProvider({ name: "whish", startAttempt: (i) => gw.startAttempt(i), attemptStatus: (id) => gw.attemptStatus(id), start: gw.start, verify: gw.verify, refund: gw.refund,
    listCharges: async (a, b) => [...await gw.listCharges(a, b), { externalRef: null, providerRef: "G-bad", amount: -5, currency: "USD" }] }, { listTimeoutMs: 500 });
  const r = await run({ provider: badList });
  rep("R11c one malformed record in the charge list: the whole list is refused and reported (charge_list); the watermark does not move; the valid charge beside it is not recorded from that list",
    r.problems.includes("charge_list") && (await watermark()) === wm && (await chargesOf(c.providerRef)) === 0, { problems: r.problems });
  await runUntilClean(3);
  rep("R11d ...a well-formed list afterwards records it, once", (await chargesOf(c.providerRef)) === 1);
}

// ------------------------------------------------------------------ R12 open attempts of another provider (review 25 Nov)
// After a provider switch (simulated → whish, or a later change), attempts of the old provider stay open: only that
// provider's runner could ever settle them, and attempts_to_check gives never-checked rows first. Skipping them without
// marking them checked kept them at the head of the queue on every run, so `limit` of them could starve every attempt
// of the real provider for ever. They must rotate like unanswerable attempts (R4), and still be reported every run.
{
  const old = [];
  for (let i = 0; i < 12; i++) old.push(await holdAndStart());
  await q("update payment_attempts set provider = 'simulated', last_checked_at = null where id = any($1::uuid[])", [old.map((x) => x.attempt)]);
  const real = [];
  for (let i = 0; i < 4; i++) real.push(await holdAndStart());
  await q("update payment_attempts set last_checked_at = now(), checks = 0 where id = any($1::uuid[])", [real.map((x) => x.attempt)]);
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push((await run({ limit: 10 })).problems);
  const asked = Number(await one("select count(*) from payment_attempts where id = any($1::uuid[]) and checks > 0", [real.map((x) => x.attempt)]));
  const oldStill = Number(await one("select count(*) from payment_attempts where id = any($1::uuid[]) and status in ('starting', 'open')", [old.map((x) => x.attempt)]));
  rep("R12 12 open attempts of another provider, 10 asked about per run: within 3 runs the queue still reaches the 4 real ones; the other provider's attempts are left open (only their provider can settle them) and reported on every run",
    asked === 4 && oldStill === 12 && runs.every((p) => p.includes("provider_mismatch")), { asked, oldStill, runs });
  // clean up: the old provider's attempts end (as their own runner would), the real ones are paid
  for (const x of old) await service.rpc("record_attempt_result", { p_attempt: x.attempt, p_result: "expired" });
  for (const x of real) gw.pay(x.attempt);
  await runUntilClean(8, { limit: 25 });
}

// ------------------------------------------------------------------ invariants over the whole database
const inv = {
  primary: Number(await one(`select count(*) from payment_attempts a where (a.status = 'succeeded') <> ((select count(*) from fee_charges c where c.attempt_id = a.id and c.reason is distinct from 'extra_charge') = 1)`)),
  kept: Number(await one(`select count(*) from payments p where p.kind = 'fee_only' and (p.status = 'paid') <> ((select count(*) from fee_charges c where c.payment_id = p.id and c.disposition = 'kept') = 1)`)),
  dupRefs: Number(await one("select count(*) from (select provider, provider_ref from fee_charges group by 1, 2 having count(*) > 1) x")),
  noDisposition: Number(await one("select count(*) from fee_charges where disposition is null or disposition not in ('kept', 'refund_due', 'refunded')")),
  overlap: Number(await one(`select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period`)),
};
rep("I every succeeded attempt has exactly one primary charge, every paid fee one kept charge, no provider reference twice, every charge a disposition, no slot double-booked",
  Object.values(inv).every((n) => n === 0), inv);

console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
await db.end();
process.exit(fails ? 1 : 0);
