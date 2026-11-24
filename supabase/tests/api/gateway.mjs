// M12.2 preparation: the provider-independent payment design against the REAL database through Supabase's API
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
const players = Array.from({ length: 20 }, (_, i) => U(i + 1));
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
let clock = Date.now();
const gw = new FakeGateway(() => clock);
async function holdAndStart(mode = "ok") {
  const who = players[playerN++];
  const p = asUser(who);
  const court = await newCourt();
  const { data: h, error } = await p.rpc("hold_slot", { p_club: CLUB, p_court: court, p_start: await at(3, "10:00"), p_end: await at(3, "11:00"), p_token: randomUUID() });
  if (error) throw new Error(`hold: ${error.message}`);
  // the deployment's provider is the gateway (on a real deployment: app.payment_provider and PAYMENT_PROVIDER)
  await q("update payments set provider = 'whish' where id = $1", [h[0].payment_id]);
  const { data: a, error: e2 } = await p.rpc("start_payment_attempt", { p_payment: h[0].payment_id, p_request: randomUUID() });
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
  return { who, p, court, booking: h[0].booking_id, payment: h[0].payment_id, attempt, started };
}
const state = async (x) => (await q(`select b.status as booking, p.status as payment, a.status as attempt, a.outcome,
  (select string_agg(disposition || coalesce(':' || reason, ''), ',' order by disposition, reason) from fee_charges c where c.payment_id = p.id) as charges
  from bookings b join payments p on p.booking_id = b.id join payment_attempts a on a.payment_id = p.id where a.id = $1`, [x.attempt]))[0];
const sweep = (extra = {}) => runPaymentReconciliation(service, gw, { minAgeSeconds: 0, now: new Date(clock), ...extra });

// ------------------------------------------------------------------ scenarios
// G1 lost callback: the player paid, no callback ever came; the run finds it
{
  const x = await holdAndStart();
  gw.pay(x.attempt);
  const r = await sweep();
  const s = await state(x);
  rep("G1 paid, callback lost: the reconciliation run asks the gateway and the booking is confirmed", s.booking === "confirmed" && s.charges === "kept" && r.problems.length === 0, { s, r: r.problems });
  const again = await sweep();
  rep("G1 ...running again changes nothing (one charge)", (await state(x)).charges === "kept" && again.problems.length === 0, again.reconcile);
}
// G2 the start timed out AFTER the gateway created the page; the player paid it anyway
{
  const x = await holdAndStart("timeout_after_create");
  const before = await state(x);
  gw.pay(x.attempt);
  await sweep();
  const s = await state(x);
  rep("G2 start timed out after the page existed, then paid: the attempt stayed unresolved and the run confirms the booking",
    x.started === "uncertain" && before.attempt === "starting" && s.booking === "confirmed" && s.charges === "kept", { before, s });
}
// G3 the start never reached the gateway: "unknown" — pending inside the grace period, expired after it; a new attempt then works
{
  const x = await holdAndStart("timeout_before_create");
  await sweep();
  const inside = await state(x);
  const blocked = await x.p.rpc("start_payment_attempt", { p_payment: x.payment, p_request: randomUUID() });
  // the attempt's age as the run sees it: move the run's clock past the grace period
  await sweep({ now: new Date(Date.now() + (UNKNOWN_GRACE_MINUTES + 1) * 60_000) });
  const after = await state(x);
  const next = await x.p.rpc("start_payment_attempt", { p_payment: x.payment, p_request: randomUUID() });
  rep(`G3 a start the gateway never received: pending for ${UNKNOWN_GRACE_MINUTES} min (no second attempt meanwhile), then expired, and the next attempt starts`,
    inside.attempt === "starting" && /attempt_in_progress/.test(blocked.error?.message ?? "") && after.attempt === "expired" && after.booking === "pending" && !next.error && next.data[0].attempt_no === 2,
    { inside: inside.attempt, blocked: blocked.error?.message, after: after.attempt, next: next.error?.message });
}
// G4 the page expired silently (no callback on expiry)
{
  const x = await holdAndStart();
  clock += (gw.pageMinutes + 1) * 60_000;
  await sweep();
  const s = await state(x);
  clock = Date.now();
  rep("G4 a page that expired with no notice is recorded as expired; the hold is untouched", s.attempt === "expired" && s.booking === "pending" && s.payment === "pending", s);
}
// G5 a second charge on the same page that only the gateway's list shows
{
  const x = await holdAndStart();
  gw.pay(x.attempt);
  gw.pay(x.attempt);                                  // the gateway let the page be paid twice
  const r = await sweep();
  const s = await state(x);
  rep("G5 a second charge only the gateway's own list shows: recorded as an extra charge owed back; booking confirmed once",
    s.booking === "confirmed" && s.charges === "kept,refund_due:extra_charge" && r.reconcile?.outcomes.extra_charge >= 1, { s, r: r.reconcile });
}
// G6 a charge whose reference is not ours
{
  const c = gw.foreignCharge(1, "USD");
  await sweep();
  const row = (await q("select disposition, reason, payment_id from fee_charges where provider = 'whish' and provider_ref = $1", [c.providerRef]))[0];
  rep("G6 a charge with a reference that is not ours: recorded as unmatched, owed back", row?.disposition === "refund_due" && row?.reason === "unmatched" && row?.payment_id === null, row);
}
// G7 the gateway took a different amount
{
  const x = await holdAndStart();
  gw.pay(x.attempt, { amount: 0.75 });
  await sweep();
  const s = await state(x);
  rep("G7 the gateway took a different amount: recorded and owed back, the booking not confirmed", s.booking === "pending" && s.charges === "refund_due:wrong_amount", s);
}
// G8 the late success: the hold ended and another player took the slot before the payment was found
{
  const x = await holdAndStart();
  await q("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [x.booking]);
  const other = asUser(players[playerN++]);
  const taken = await other.rpc("hold_slot", { p_club: CLUB, p_court: x.court, p_start: await at(3, "10:00"), p_end: await at(3, "11:00"), p_token: randomUUID() });
  gw.pay(x.attempt);
  await sweep();
  const s = await state(x);
  rep("G8 paid after the hold ended and the slot was taken: recorded and owed back; the slot keeps its one booking",
    !taken.error && s.booking === "expired" && s.charges === "refund_due:not_confirmed"
    && Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [x.court])) === 1, s);
}
// G9 the run and a callback at the same moment, and two runs at the same moment
{
  const x = await holdAndStart();
  gw.pay(x.attempt);
  const [r1, r2, cb] = await Promise.all([sweep(), sweep(),
    (async () => { const st = await gw.attemptStatus(x.attempt); return service.rpc("record_attempt_result", { p_attempt: x.attempt, p_result: "succeeded", p_provider_ref: st.evidence.providerRef, p_amount: st.evidence.amount, p_currency: st.evidence.currency }); })()]);
  const s = await state(x);
  rep("G9 two runs and a callback at once: confirmed once, one charge, no problem reported", s.booking === "confirmed" && s.charges === "kept" && !cb.error && r1.problems.length === 0 && r2.problems.length === 0,
    { s, p: [r1.problems, r2.problems], cb: cb.error?.message });
}
// G10 outages: the status API and the list API down — nothing is decided, problems are reported, nothing is lost
{
  const x = await holdAndStart();
  gw.pay(x.attempt);
  gw.statusDown = true; gw.listDown = true;
  const r = await sweep();
  const during = await state(x);
  gw.statusDown = false; gw.listDown = false;
  await sweep();
  const after = await state(x);
  rep("G10 gateway outage: nothing decided, the run reports it; once back, the next run confirms",
    during.attempt === "open" && during.booking === "pending" && r.problems.includes("sweep_failures") && r.problems.includes("charge_list") && after.booking === "confirmed",
    { during, r: r.problems, after: after.booking });
}
// G11 a refused start ends the attempt at once, and the next one starts
{
  const x = await holdAndStart("refused");
  const s = await state(x);
  const next = await x.p.rpc("start_payment_attempt", { p_payment: x.payment, p_request: randomUUID() });
  rep("G11 a start the gateway refused: attempt failed at once, the hold kept, attempt 2 starts", x.started === "refused" && s.attempt === "failed" && s.booking === "pending" && !next.error, { s, next: next.error?.message });
}

// ------------------------------------------------------------------ invariants over the whole database
const inv = {
  primary: Number(await one(`select count(*) from payment_attempts a where (a.status = 'succeeded') <> ((select count(*) from fee_charges c where c.attempt_id = a.id and c.reason is distinct from 'extra_charge') = 1)`)),
  kept: Number(await one(`select count(*) from payments p where p.kind = 'fee_only' and (p.status = 'paid') <> ((select count(*) from fee_charges c where c.payment_id = p.id and c.disposition = 'kept') = 1)`)),
  gwCharges: Number(await one("select count(*) from fee_charges where provider = 'whish'")),
  overlap: Number(await one(`select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period`)),
};
const gatewayCharges = (await gw.listCharges()).length;
rep("I every charge in the gateway's own list is recorded exactly once; every paid fee has one kept charge; no slot double-booked",
  inv.primary === 0 && inv.kept === 0 && inv.gwCharges === gatewayCharges && inv.overlap === 0, { ...inv, gatewayCharges });

console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
await db.end();
process.exit(fails ? 1 : 0);
