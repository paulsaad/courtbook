// M12.3 Part 1B: the booking-fee money lifecycle end to end against the REAL database (local PostgREST, real
// functions, players / staff / admin with their own tokens, the server with the service key), driven by the FAKE
// gateway (generic behaviours, not Whish). Every verified charge must end with a traceable disposition, and no charge
// may disappear because a call timed out or an account was deleted.
//   L1  pay $1 → confirmed, fee kept              L7  a charge that is not CourtBook's
//   L2  the player cancels → CourtBook keeps it    L8  a refund that cannot be completed (wrong amount, never collected)
//   L3  the club cancels → owed back              L9  a refund recorded twice
//   L4  paid after the slot became unavailable    L10 a charge discovered after an earlier failure
//   L5  paid twice                                 L11 account deletion with a refund outstanding / money still coming
//   L6  the provider reports a wrong amount       L12 a payment arriving while the booking is being cancelled (race)
// LOCAL ONLY. Run: PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && SCRIPT=ledger.mjs PSQL="sudo -u postgres psql" bash supabase/tests/api/journey.sh
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { API_DB, asService, asUser } from "./lib.mjs";
import { FakeGateway } from "../../../src/lib/payments/testing/fakeGateway.ts";
import { runPaymentReconciliation } from "../../../src/lib/payments/reconcile.ts";
import { verifyAndRecord } from "../../../src/lib/payments/attempts.ts";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);

let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); } };
const db = new Client({ connectionString: `postgresql:///${API_DB}?host=/var/run/postgresql` }); await db.connect();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];

const U = (n) => `a4100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const players = Array.from({ length: 80 }, (_, i) => U(i + 1));
const ADMIN = U(900), STAFF = U(901);
await q("insert into auth.users (id, phone) select x, '+961714' || lpad(n::text, 5, '0') from unnest($1::uuid[]) with ordinality t(x, n) on conflict do nothing", [[...players, ADMIN, STAFF]]);
await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [[...players, ADMIN, STAFF]]);
await q("update profiles set roles = '{player,admin}' where id = $1", [ADMIN]);
const CLUB = await one("select id from clubs where slug = 'batroun'");
await q("update clubs set payment_mode = 'fee_online', service_fee_usd = 1, hold_minutes = 10, max_upcoming_bookings = 20, cancel_cutoff_hours = 6 where id = $1", [CLUB]);
await q("insert into club_staff (club_id, profile_id) values ($1, $2) on conflict do nothing", [CLUB, STAFF]);
const service = asService(), admin = asUser(ADMIN), staff = asUser(STAFF);
const at = (d, hhmm) => one(`select (((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut')`, [hhmm]);
let courtN = 0, playerN = 0;
const newCourt = async () => {
  const id = await one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 960) returning id", [CLUB, `zz-led-${++courtN}`]);
  await q("insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ($1, $2, 127, '00:00', '23:59', 25, 'led')", [CLUB, id]);
  return id;
};
const gw = new FakeGateway(() => Date.now());
async function holdAndStart(opts = {}) {
  const who = opts.who ?? players[playerN++];
  const p = asUser(who);
  const court = opts.court ?? await newCourt();
  const { data: h, error } = await p.rpc("hold_slot", { p_club: CLUB, p_court: court, p_start: await at(opts.day ?? 3, "10:00"), p_end: await at(opts.day ?? 3, "11:00"), p_token: randomUUID() });
  if (error) throw new Error(`hold: ${error.message}`);
  await q("update payments set provider = 'whish' where id = $1", [h[0].payment_id]);
  const { data: a, error: e2 } = await p.rpc("start_payment_attempt", { p_payment: h[0].payment_id, p_request: randomUUID() });
  if (e2) throw new Error(`attempt: ${e2.message}`);
  const attempt = a[0].attempt_id;
  gw.nextStart.push(opts.mode ?? "ok");
  try {
    const s = await gw.startAttempt({ attemptId: attempt, amountUsd: 1, currency: "USD", description: "fee", returnUrl: "https://x.example/r", callbackUrl: "https://x.example/c" });
    await service.rpc("open_payment_attempt", { p_attempt: attempt, p_session_url: s.url, p_provider_session: s.session });
  } catch (e) { if (e.name === "PaymentStartRefused") await service.rpc("abandon_payment_attempt", { p_attempt: attempt, p_note: "refused" }); }
  return { who, p, court, booking: h[0].booking_id, payment: h[0].payment_id, attempt };
}
const settle = (x) => verifyAndRecord(service, gw, x.attempt);              // the callback / return page / sweep path
const run = () => runPaymentReconciliation(service, gw, { minAgeSeconds: 0 });
const ledger = (x) => q("select provider_ref, disposition, coalesce(reason, '-') reason, amount, collected from fee_charges where payment_id = $1 order by received_at, provider_ref", [x.payment]);
const booking = (x) => one("select status from bookings where id = $1", [x.booking]);
const payment = (x) => one("select status from payments where id = $1", [x.payment]);
const dues = async () => (await admin.rpc("fee_refunds_due")).data ?? [];
const fmt = (rows) => rows.map((r) => `${r.disposition}:${r.reason}`).join(",");
await service.rpc("initialise_reconciliation_watermark", { p_provider: "whish", p_from: new Date(Date.now() - 60_000).toISOString() });

// L1 ------------------------------------------------------------------------------------------------------------------
const l1 = await holdAndStart({ day: 4 });
gw.pay(l1.attempt);
const r1 = await settle(l1);
rep("L1 paid $1: booking confirmed, payment paid, one charge kept (collected, real provider)",
  r1.ok && await booking(l1) === "confirmed" && await payment(l1) === "paid" && fmt(await ledger(l1)) === "kept:-" && (await ledger(l1))[0].collected === true,
  { r1, l: await ledger(l1) });

// L2 ------------------------------------------------------------------------------------------------------------------
{
  const c = await l1.p.rpc("cancel_booking", { p_booking: l1.booking, p_club_caused: false });
  const ref1 = (await ledger(l1))[0].provider_ref;
  const due = (await dues()).filter((d) => d.provider_ref === ref1);
  rep("L2 the player cancels (before the cutoff): booking cancelled; CourtBook keeps the fee — charge still kept, payment still paid, nothing owed",
    !c.error && await booking(l1) === "cancelled" && fmt(await ledger(l1)) === "kept:-" && await payment(l1) === "paid" && due.length === 0, { e: c.error?.message, l: await ledger(l1) });
  const tryClub = await staff.rpc("cancel_booking", { p_booking: l1.booking, p_club_caused: true });
  rep("L2b ...a later club cancellation of the same (already cancelled) booking changes nothing", fmt(await ledger(l1)) === "kept:-", tryClub.error?.message);
}

// L3 ------------------------------------------------------------------------------------------------------------------
const l3 = await holdAndStart({ day: 4 });
gw.pay(l3.attempt); await settle(l3);
{
  const c = await staff.rpc("cancel_booking", { p_booking: l3.booking, p_club_caused: true });
  const ref = (await ledger(l3))[0].provider_ref;
  const due = (await dues()).find((d) => d.provider_ref === ref);
  const playerSees = await l3.p.rpc("fee_refunds_due");
  const staffSees = await staff.rpc("fee_refunds_due");
  rep("L3 the club cancels: the fee is owed back (refund_due, club_cancelled), payment refund_due, listed for the admin — and only for the admin",
    !c.error && fmt(await ledger(l3)) === "refund_due:club_cancelled" && await payment(l3) === "refund_due" && due?.reason === "club_cancelled"
    && (!!playerSees.error || (playerSees.data ?? []).length === 0) && (!!staffSees.error || (staffSees.data ?? []).length === 0),
    { e: c.error?.message, l: await ledger(l3), player: playerSees.error?.message, staff: staffSees.error?.message });
}

// L4 ------------------------------------------------------------------------------------------------------------------
{
  const court = await newCourt();
  const x = await holdAndStart({ court, day: 5 });
  await q("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [x.booking]);
  const other = await asUser(players[playerN++]).rpc("hold_slot", { p_club: CLUB, p_court: court, p_start: await at(5, "10:00"), p_end: await at(5, "11:00"), p_token: randomUUID() });
  gw.pay(x.attempt);
  await settle(x);
  rep("L4 paid after the hold ended and another player took the slot: recorded and owed back (not_confirmed); the slot keeps the other player's hold",
    !other.error && fmt(await ledger(x)) === "refund_due:not_confirmed" && await booking(x) !== "confirmed"
    && Number(await one("select count(*) from bookings where court_id = $1 and status in ('pending','confirmed')", [court])) === 1, { e: other.error?.message, l: await ledger(x) });
}

// L5, L6, L7 -------------------------------------------------------------------------------------------------------------
{
  const x = await holdAndStart({ day: 5 });
  gw.pay(x.attempt); await settle(x); gw.pay(x.attempt);              // a second charge on the same page
  const w = await holdAndStart({ day: 5 });
  gw.pay(w.attempt, { amount: 2 }); await settle(w);                    // the provider reports $2
  const f = gw.foreignCharge(1);
  for (let i = 0; i < 3; i++) await run();
  const fr = await q("select disposition, coalesce(reason, '-') reason, payment_id from fee_charges where provider_ref = $1", [f.providerRef]);
  rep("L5 paid twice: the first charge kept (confirmed once), the second recorded and owed back (extra_charge)", fmt(await ledger(x)) === "kept:-,refund_due:extra_charge" && await booking(x) === "confirmed", await ledger(x));
  rep("L6 a wrong amount: recorded and owed back (wrong_amount); the booking NOT confirmed", fmt(await ledger(w)) === "refund_due:wrong_amount" && await booking(w) !== "confirmed", { l: await ledger(w), b: await booking(w) });
  rep("L7 a charge that is not CourtBook's: recorded with no payment and owed back (unmatched)", fr.length === 1 && fr[0].disposition === "refund_due" && fr[0].reason === "unmatched" && fr[0].payment_id === null, fr);
}

// L8, L9 ----------------------------------------------------------------------------------------------------------------
{
  const due = (await ledger(l3))[0];
  const id = await one("select id from fee_charges where provider_ref = $1", [due.provider_ref]);
  const wrongAmount = await admin.rpc("complete_fee_refund", { p_charge: id, p_amount: 2, p_method: "provider_portal", p_reference: "RF-1" });
  const noRef = await admin.rpc("complete_fee_refund", { p_charge: id, p_amount: 1, p_method: "provider_portal", p_reference: " " });
  const byStaff = await staff.rpc("complete_fee_refund", { p_charge: id, p_amount: 1, p_method: "provider_portal", p_reference: "RF-1" });
  const byPlayer = await l3.p.rpc("complete_fee_refund", { p_charge: id, p_amount: 1, p_method: "provider_portal", p_reference: "RF-1" });
  rep("L8 a refund that is not done correctly (wrong amount, no reference) or by anyone but an admin is refused: the charge stays owed back and listed",
    /refund_amount_mismatch/.test(wrongAmount.error?.message ?? "") && /reference_required/.test(noRef.error?.message ?? "") && /forbidden/.test(byStaff.error?.message ?? "")
    && /forbidden/.test(byPlayer.error?.message ?? "") && fmt(await ledger(l3)) === "refund_due:club_cancelled" && (await dues()).some((d) => d.charge_id === id),
    { wrongAmount: wrongAmount.error?.message, noRef: noRef.error?.message, byStaff: byStaff.error?.message, byPlayer: byPlayer.error?.message });
  // a simulated (never collected) charge cannot be "refunded"
  await q("update clubs set is_demo = true where id = $1", [CLUB]);
  const sim = await asUser(players[playerN++]).rpc("hold_slot", { p_club: CLUB, p_court: await newCourt(), p_start: await at(6, "10:00"), p_end: await at(6, "11:00"), p_token: randomUUID() });
  let simRefund = { error: { message: "no hold" } };
  if (!sim.error) {
    const sp = sim.data[0].payment_id;
    const sa = await asUser(players[playerN - 1]).rpc("start_payment_attempt", { p_payment: sp, p_request: randomUUID() });
    await service.rpc("record_attempt_result", { p_attempt: sa.data[0].attempt_id, p_result: "succeeded", p_provider_ref: `SIM-${randomUUID()}`, p_amount: 1, p_currency: "USD" });
    await staff.rpc("cancel_booking", { p_booking: sim.data[0].booking_id, p_club_caused: true });
    const sid = await one("select id from fee_charges where payment_id = $1", [sp]);
    simRefund = await admin.rpc("complete_fee_refund", { p_charge: sid, p_amount: 1, p_method: "provider_portal", p_reference: "RF-SIM" });
  }
  rep("L8b a simulated charge (no money was collected) cannot be marked refunded", /never_collected/.test(simRefund.error?.message ?? ""), { hold: sim.error?.message, r: simRefund.error?.message });
  const okr = await admin.rpc("complete_fee_refund", { p_charge: id, p_amount: 1, p_method: "provider_portal", p_reference: "RF-1" });
  const again = await admin.rpc("complete_fee_refund", { p_charge: id, p_amount: 1, p_method: "provider_portal", p_reference: "RF-1" });
  const other = await admin.rpc("complete_fee_refund", { p_charge: id, p_amount: 1, p_method: "provider_portal", p_reference: "RF-2" });
  const x5 = await one("select id from fee_charges where reason = 'extra_charge' limit 1");
  const reuse = await admin.rpc("complete_fee_refund", { p_charge: x5, p_amount: 1, p_method: "provider_portal", p_reference: "RF-1" });
  rep("L9 the refund recorded once (refunded, payment refunded); the same report again is a no-op (already_refunded); another reference for it, or the same reference for another charge, is refused",
    okr.data === "refunded" && again.data === "already_refunded" && /already_refunded/.test(other.error?.message ?? "") && /refund_reference_used/.test(reuse.error?.message ?? "")
    && fmt(await ledger(l3)) === "refunded:club_cancelled" && await payment(l3) === "refunded" && !(await dues()).some((d) => d.charge_id === id),
    { okr: okr.data, again: again.data, other: other.error?.message, reuse: reuse.error?.message });
}

// L10 ------------------------------------------------------------------------------------------------------------------
{
  const x = await holdAndStart({ day: 6 });
  gw.decline(x.attempt); await settle(x);
  const failedFirst = await one("select status from payment_attempts where id = $1", [x.attempt]);
  // the provider later shows a charge for that reference after all (its own list): never dropped
  gw.pages.get(x.attempt).state = "open"; gw.pay(x.attempt);
  for (let i = 0; i < 3; i++) await run();
  const l = await ledger(x);
  rep("L10 an attempt recorded as failed, then a charge for it appears in the provider's list: recorded, with a disposition (never lost)",
    failedFirst === "failed" && l.length === 1 && ["kept", "refund_due"].includes(l[0].disposition), { failedFirst, l });
}

// L11 ------------------------------------------------------------------------------------------------------------------
{
  // a refund outstanding for this player (club cancellation), and a hold whose money is still on its way
  const owed = await holdAndStart({ day: 7 });
  gw.pay(owed.attempt); await settle(owed);
  await staff.rpc("cancel_booking", { p_booking: owed.booking, p_club_caused: true });
  const coming = await holdAndStart({ who: owed.who, day: 8 });   // (a new hold of the same player)
  const ownedRef = (await ledger(owed))[0].provider_ref;
  // the account is deleted the way the pipeline does it: request, data step, the sign-in removed, finish
  await q("insert into account_deletions (subject_id, requested_via, status) values ($1, 'app', 'closed')", [owed.who]);
  const del = await service.rpc("delete_account_data", { p_subject: owed.who, p_cancel_only: false });
  await q("delete from auth.users where id = $1", [owed.who]);
  const fin = await service.rpc("finish_account_deletion", { p_subject: owed.who });
  gw.pay(coming.attempt);                                         // the money for the released hold arrives afterwards
  for (let i = 0; i < 3; i++) await run();
  const refundStill = (await dues()).find((d) => d.provider_ref === ownedRef);
  const comingLedger = await ledger(coming);
  const okr = await admin.rpc("complete_fee_refund", { p_charge: refundStill?.charge_id ?? randomUUID(), p_amount: 1, p_method: "provider_portal", p_reference: "RF-DEL" });
  rep("L11 account deleted (data step, sign-in removed, finished) with a refund outstanding: the charge and its payment survive (payment no longer names the person), still listed and still refundable by the admin",
    !del.error && !fin.error && !!refundStill && (await one("select profile_id from payments where id = $1", [owed.payment])) === null && okr.data === "refunded",
    { del: del.error?.message, fin: fin.error?.message, refundStill: !!refundStill, okr: okr.error?.message ?? okr.data });
  rep("L11b money for a hold released by the deletion arrives afterwards: recorded and owed back — not lost with the account",
    comingLedger.length === 1 && comingLedger[0].disposition === "refund_due", comingLedger);
}

// L12 ------------------------------------------------------------------------------------------------------------------
{
  const outcomes = {};
  for (let i = 0; i < 12; i++) {
    const x = await holdAndStart({ day: 9 + (i % 3) });
    gw.pay(x.attempt);
    // the player releases the hold (or cancels) at the same moment the payment result is recorded
    const [cancel] = await Promise.all([
      i % 2 ? x.p.rpc("release_hold", { p_booking: x.booking }) : x.p.rpc("cancel_booking", { p_booking: x.booking, p_club_caused: false }),
      settle(x),
    ]);
    const b = await booking(x), l = await ledger(x);
    const key = `${b}/${fmt(l)}`;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    void cancel;
  }
  console.log("L12 outcomes", JSON.stringify(outcomes));
  const allowed = new Set(["cancelled/kept:-", "expired/refund_due:not_confirmed", "cancelled/refund_due:not_confirmed", "confirmed/kept:-"]);
  rep("L12 12 payments recorded while the booking is being cancelled or released: every one ends with exactly one charge and a disposition that matches the booking (kept if it was confirmed first, owed back if not)",
    Object.keys(outcomes).every((k) => allowed.has(k)), outcomes);
}

// invariants ------------------------------------------------------------------------------------------------------------
const inv = {
  noDisposition: Number(await one("select count(*) from fee_charges where disposition not in ('kept','refund_due','refunded')")),
  keptWithReason: Number(await one("select count(*) from fee_charges where disposition = 'kept' and reason is not null")),
  owedWithoutReason: Number(await one("select count(*) from fee_charges where disposition <> 'kept' and reason is null")),
  refundedWithoutProof: Number(await one("select count(*) from fee_charges where disposition = 'refunded' and (refund_reference is null or refund_amount is distinct from amount)")),
  succeededWithoutCharge: Number(await one("select count(*) from payment_attempts a where a.status = 'succeeded' and not exists (select 1 from fee_charges c where c.attempt_id = a.id)")),
  paidWithoutKept: Number(await one("select count(*) from payments p where p.kind = 'fee_only' and p.status = 'paid' and not exists (select 1 from fee_charges c where c.payment_id = p.id and c.disposition = 'kept')")),
};
const gatewayCharges = [...gw.pages.values()].reduce((n, p) => n + p.charges.length, 0) + gw.foreign.length;
const recorded = Number(await one("select count(*) from fee_charges where provider = 'whish'"));
rep("I every charge the gateway took is in the ledger exactly once with a disposition and a reason that fits it; every refund has its proof; every succeeded attempt and every paid fee has its charge",
  Object.values(inv).every((n) => n === 0) && recorded === gatewayCharges, { ...inv, recorded, gatewayCharges });

console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
await db.end();
process.exit(fails ? 1 : 0);
