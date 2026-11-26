// Role matrix for the booking and money boundaries (overnight assignment of 26 Nov, priority 3). Each case runs as a
// real database role (anon, authenticated with a JWT subject, service_role) in its own transaction, which is ROLLED
// BACK, against a scratch database migrated to the head of this branch. A case passes only when the caller is refused
// or sees nothing it may not see — and the money/booking rows are unchanged afterwards.
//
// Actors: player A, player B (another player), staff of club X, staff of club Y, an admin, anon.
// Env: DB (local socket connection string), PG_MODULE. LOCAL ONLY.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const DB = process.env.DB;
if (!DB || !/\/\/\/[a-z0-9_]+\?host=\/var\/run\/postgresql$/.test(DB)) { console.log("refusing: DB must be a local socket database"); process.exit(2); }

let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => {
  if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); }
};
const admin = new Client({ connectionString: DB }); await admin.connect();
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];

// ------------------------------------------------------------------ fixtures (fictional)
await q("alter database " + (await one("select current_database()")) + " set app.payment_provider = 'whish'");
const X = await one("select id from clubs where slug = 'batroun'");
await q("update clubs set is_demo = false, payment_mode = 'fee_online', service_fee_usd = 1, max_upcoming_bookings = 20 where id = $1", [X]);
const Y = await one("insert into clubs (name, slug, payment_mode, service_fee_usd) values ('Role Club Y', 'role-y', 'at_desk', 0) returning id");
const courtY = await one("insert into courts (club_id, name, sport) values ($1, 'Y1', 'padel') returning id", [Y]);
await q("insert into price_rules (club_id, start_time, end_time, price_usd, label) values ($1, '08:00', '23:00', 20, 'all day')", [Y]);
const U = (n) => `be000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = U(1), B = U(2), SX = U(11), SY = U(12), ADM = U(20);
await q("insert into auth.users (id, phone) select x, '+9617170' || lpad(n::text, 4, '0') from unnest($1::uuid[]) with ordinality t(x, n) on conflict do nothing", [[A, B, SX, SY, ADM]]);
await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [[A, B, SX, SY, ADM]]);
await q("update profiles set roles = '{player,admin}' where id = $1", [ADM]);
await q("insert into club_staff (club_id, profile_id) values ($1, $2), ($3, $4) on conflict do nothing", [X, SX, Y, SY]);
const courtX = await one("select id from courts where club_id = $1 and active order by name limit 1", [X]);

async function as(who, fn) {
  const c = new Client({ connectionString: DB }); await c.connect();
  await c.query("begin");
  if (who === "anon") await c.query("set local role anon");
  else if (who === "service") await c.query("set local role service_role");
  else {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [who, JSON.stringify({ sub: who, role: "authenticated", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }] })]);
  }
  try { return await fn(c); } finally { await c.query("rollback").catch(() => {}); await c.end(); }
}
/** Commit-for-real helper used only to build fixtures through the real functions. */
async function real(who, sql, args = []) {
  const c = new Client({ connectionString: DB }); await c.connect();
  await c.query("begin");
  await c.query("set local role " + (who === "service" ? "service_role" : "authenticated"));
  if (who !== "service") await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
    [who, JSON.stringify({ sub: who, role: "authenticated", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }] })]);
  try { const r = await c.query(sql, args); await c.query("commit"); return r.rows; } catch (e) { await c.query("rollback"); throw e; } finally { await c.end(); }
}
const attempt = async (who, sql, args = []) => as(who, async (c) => {
  try { const r = await c.query(sql, args); return { rows: r.rows, count: r.rowCount }; } catch (e) { return { err: String(e.message) }; }
});
const refused = (r) => !!r.err;
const denied = (r) => /permission denied/.test(r.err ?? "");
const empty = (r) => !r.err && (r.rows?.length ?? 0) === 0;
const zeroRows = (r) => !r.err && r.count === 0;

// ------------------------------------------------------------------ real state to attack: B's paid fee booking at X; a desk booking at Y
const at = async (hhmm, days) => one(`select ((current_date + ${days})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hhmm]);
const hB = (await real(B, "select booking_id, payment_id from hold_slot($1, $2, $3, $4, $5)", [X, courtX, await at("10:00", 3), await at("11:00", 3), randomUUID()]))[0];
const aB = (await real(B, "select attempt_id from start_payment_attempt($1, $2)", [hB.payment_id, randomUUID()]))[0].attempt_id;
await real("service", "select open_payment_attempt($1, 'https://pay.invalid/x', 's')", [aB]);
await real("service", "select record_attempt_result($1, 'succeeded', $2, 1, 'USD')", [aB, `rm-${randomUUID()}`]);
const hB2 = (await real(B, "select booking_id, payment_id from hold_slot($1, $2, $3, $4, $5)", [X, courtX, await at("12:00", 3), await at("13:00", 3), randomUUID()]))[0];
const deskY = (await real(SY, "select staff_book($1, $2, $3, $4, 'Walk-in Y', '+96170111222') as id", [Y, courtY, await at("14:00", 3), await at("15:00", 3)]))[0].id;
await real(SX, "select cancel_booking($1, true)", [hB.booking_id]);           // club-caused at X: B's fee now owed back
const chargeB = await one("select id from fee_charges where payment_id = $1", [hB.payment_id]);
const snapshot = async () => JSON.stringify(await q(`select (select json_agg(row_to_json(b) order by id) from bookings b) bk,
  (select json_agg(row_to_json(p) order by id) from payments p) py, (select json_agg(row_to_json(a) order by id) from payment_attempts a) at,
  (select json_agg(row_to_json(c) order by id) from fee_charges c) ch`));
const before = await snapshot();

// ================================================================== player A against B's records
rep("R1 player A reads B's bookings: none", empty(await attempt(A, "select id from bookings where player_id = $1", [B])));
rep("R2 player A reads B's payments: none", empty(await attempt(A, "select id from payments where profile_id = $1", [B])));
rep("R3 player A reads B's payment attempts: none", empty(await attempt(A, "select id from payment_attempts where payment_id = $1", [hB.payment_id])));
rep("R4 player A reads fee charges: none (admin only)", empty(await attempt(A, "select id from fee_charges")));
rep("R5 player A reads other players' phones in profiles: none", empty(await attempt(A, "select phone from profiles where id <> $1", [A])));
rep("R6 player A starts a payment on B's hold: refused (not_found)", (await attempt(A, "select * from start_payment_attempt($1, $2)", [hB2.payment_id, randomUUID()])).err === "not_found");
rep("R7 player A releases B's hold: refused", refused(await attempt(A, "select release_hold($1)", [hB2.booking_id])));
rep("R8 player A cancels B's booking: refused", refused(await attempt(A, "select cancel_booking($1, false)", [hB2.booking_id])));
rep("R9 player A marks B's booking club-caused: refused", refused(await attempt(A, "select cancel_booking($1, true)", [hB2.booking_id])));
rep("R10 player A confirms a booking by writing the table: 0 rows", zeroRows(await attempt(A, "update bookings set status = 'confirmed' where id = $1", [hB2.booking_id])));
rep("R11 player A marks a payment paid by writing the table: 0 rows", zeroRows(await attempt(A, "update payments set status = 'paid' where id = $1", [hB2.payment_id])));
rep("R12 player A inserts a fee charge: permission denied", denied(await attempt(A, "insert into fee_charges (provider, provider_ref, amount, currency, collected, disposition) values ('whish','x',1,'USD',true,'kept')")));
for (const [fn, args] of [["record_attempt_result($1, 'succeeded', 'x', 1, 'USD')", [aB]], ["reconcile_provider_charge('whish', $1, 'x', 1, 'USD')", [aB]],
  ["open_payment_attempt($1, 'u', 's')", [aB]], ["abandon_payment_attempt($1, 'n')", [aB]], ["confirm_payment($1, 'x', 1)", [hB2.payment_id]],
  ["fail_payment($1, 'n')", [hB2.payment_id]], ["attempts_to_check('0 s', '1 h', 10)", []], ["settle_payment_on_cancel($1, 'club')", [hB2.booking_id]],
  ["advance_reconciliation_watermark('whish', now())", []], ["record_reconciliation_issue('whish','x',null,1,'USD','charge_evidence_conflict')", []]]) {
  rep(`R13 player A calls server-only ${fn.split("(")[0]}: permission denied`, denied(await attempt(A, `select ${fn}`, args)));
}
rep("R14 player A completes a fee refund: refused (forbidden)", (await attempt(A, "select complete_fee_refund($1, 1, 'provider_portal', 'R')", [chargeB])).err === "forbidden");
rep("R15 player A lists fee refunds due: empty", empty(await attempt(A, "select * from fee_refunds_due()")));
rep("R16 player A resolves a reconciliation issue: refused", refused(await attempt(A, "select resolve_reconciliation_issue($1, 'x')", [randomUUID()])));
rep("R17 player A changes a club's payment mode: refused", refused(await attempt(A, "select set_club_payment_mode($1, 'at_desk')", [X])));
rep("R18 player A reads staff contacts for a club's bookings: refused or empty", ((r) => refused(r) || empty(r))(await attempt(A, "select * from club_booking_contacts($1, $2)", [Y, [deskY]])));

// ================================================================== staff of club X against club Y
rep("R19 staff X reads club Y's bookings: none", empty(await attempt(SX, "select id from bookings where club_id = $1", [Y])));
rep("R20 staff X reads club Y's walk-in phone via contacts: refused or empty", ((r) => refused(r) || empty(r))(await attempt(SX, "select * from club_booking_contacts($1, $2)", [Y, [deskY]])));
rep("R21 staff X cancels a club Y booking: refused", refused(await attempt(SX, "select cancel_booking($1, true)", [deskY])));
rep("R22 staff X books a walk-in at club Y: refused", refused(await attempt(SX, "select staff_book($1, $2, $3, $4, 'X', null)", [Y, courtY, await at("16:00", 3), await at("17:00", 3)])));
rep("R23 staff X moves a club Y booking: refused", refused(await attempt(SX, "select move_booking($1, $2, $3, $4)", [deskY, courtY, await at("18:00", 3), await at("19:00", 3)])));
rep("R24 staff X completes CourtBook's fee refund: refused (admin only)", (await attempt(SX, "select complete_fee_refund($1, 1, 'provider_portal', 'R')", [chargeB])).err === "forbidden");
rep("R25 staff X marks CourtBook's fee refunded via the club function: refused", refused(await attempt(SX, "select mark_refunded($1)", [hB.payment_id])));
rep("R26 staff X reads fee charges: none", empty(await attempt(SX, "select id from fee_charges")));
rep("R27 staff X changes its own club's payment mode: refused (admin only)", refused(await attempt(SX, "select set_club_payment_mode($1, 'at_desk')", [X])));
rep("R28 staff Y's refund queue does not list CourtBook's fee: empty", empty(await attempt(SY, "select * from refunds_due()")));
rep("R29 staff Y's payments summary has no club X rows", ((r) => !r.err && r.rows.every((x) => x.club_id !== X))(await attempt(SY, "select * from payments_summary(current_date)")));

// ================================================================== anonymous visitor
for (const [fn, args] of [["hold_slot($1, $2, now() + interval '2 days', now() + interval '2 days 1 hour', null)", [X, courtX]],
  ["start_payment_attempt($1, $2)", [hB2.payment_id, randomUUID()]], ["cancel_booking($1, false)", [hB2.booking_id]],
  ["complete_fee_refund($1, 1, 'provider_portal', 'R')", [chargeB]], ["fee_refunds_due()", []], ["book_at_desk($1, now() + interval '2 days', now() + interval '2 days 1 hour', null)", [courtX]]]) {
  rep(`R30 anon calls ${fn.split("(")[0]}: permission denied`, denied(await attempt("anon", `select * from ${fn}`, args)));
}
rep("R31 anon reads payments: denied or empty", ((r) => denied(r) || empty(r))(await attempt("anon", "select id from payments")));
rep("R32 anon reads bookings: denied or empty", ((r) => denied(r) || empty(r))(await attempt("anon", "select id from bookings")));

// ================================================================== the admin may, and only as recorded
const adm = await attempt(ADM, "select complete_fee_refund($1, 1, 'provider_portal', 'ADMIN-R1') as r", [chargeB]);
rep("R33 the admin completes the fee refund (inside the rolled-back transaction): refunded", adm.rows?.[0]?.r === "refunded", adm);

rep("R34 nothing above changed a booking, payment, attempt or charge", before === (await snapshot()));
await admin.end();
console.log(`\n${oks} ok, ${fails} failed`);
process.exit(fails ? 1 : 0);
