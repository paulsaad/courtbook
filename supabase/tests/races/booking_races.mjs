// Booking safety under real concurrency (overnight audit, 24 Nov): two committed sessions race on a scratch copy of
// the local replica. Each scenario runs three ways:
//   ab  A's call runs inside an open transaction; B's call starts while A is still uncommitted; A commits, then B;
//   ba  the same, B first;
//   sim both calls sent at the same instant, several times.
// After every run, global invariants are checked on the whole database (not just the scenario's rows):
//   I1 no two live bookings (confirmed or pending) overlap on a court;
//   I2 no live booking overlaps a block on its court;
//   I3 money and bookings agree: a pending payment's booking is pending; a paid payment's booking is confirmed,
//      no-show or cancelled (a late cancellation keeps the money); an expired or failed booking holds no paid money;
//   I4 at most one payment row per booking; desk walk-ins have no payment row and no CourtBook fee;
//   I5 an expired or failed hold never blocks a later booking of the same slot (checked by booking it afterwards).
// FEE=1 (M12.1, 0093): the same scenarios 1–5 at a club in 'fee_online' mode (court paid at the desk, $1 fee online
// through provider-verified attempts), then the fee-only races F6–F11 instead of 6–9, with four more invariants:
//   I6 every successful attempt has exactly one charge of its own (an extra charge proven by the provider's records is
//   separate), and never two unresolved attempts on one payment; I7 a fee-only payment is paid exactly when it has one kept charge
//   (never two); I8 every confirmed fee-only booking has its kept charge; I9 no charge refunded twice, none without a
//   successful attempt or an unmatched record.
// Env: DB (connection string of the scratch database), PG_MODULE (folder holding node_modules/pg).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const DB = process.env.DB;
let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${detail}]`); } };
const admin = new Client({ connectionString: DB }); await admin.connect();
const q = async (sql, args = []) => (await admin.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fixtures
const CLUB = await one("select id from clubs where slug = 'batroun'");
const FEE = process.env.FEE === "1";
await q("update clubs set payment_mode = $2, service_fee_usd = 1, cancel_cutoff_hours = 6 where id = $1", [CLUB, FEE ? "fee_online" : "simulated"]);
// fee_online applies the club's cap on upcoming bookings (as at the desk); these scenarios confirm many for one player
if (FEE) await q("update clubs set max_upcoming_bookings = 20 where id = $1", [CLUB]);
console.log(`mode: ${FEE ? "fee_online (M12.1)" : "simulated (Model 1)"}`);
const U = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = U(1), P2 = U(2), S1 = U(3), S2 = U(4), X = U(5);   // two players, two desk staff of this club, staff of another
await q(`insert into auth.users (id, phone) values ($1,'+96170000001'),($2,'+96170000002'),($3,'+96170000003'),($4,'+96170000004'),($5,'+96170000005') on conflict do nothing`, [P1, P2, S1, S2, X]);
await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [[P1, P2, S1, S2, X]]);
await q("insert into club_staff (club_id, profile_id) values ($1,$2),($1,$3) on conflict do nothing", [CLUB, S1, S2]);
await q("insert into club_staff (club_id, profile_id) select id, $1 from clubs where slug = 'other' on conflict do nothing", [X]);
let courtN = 0;
const newCourt = async () => one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 900) returning id", [CLUB, `zz-race-${++courtN}`]);
const DAY = 3;
const at = async (hhmm, days = DAY) => one(`select ((current_date + ${days})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hhmm]);
const T10 = await at("10:00"), T11 = await at("11:00"), T1030 = await at("10:30"), T1130 = await at("11:30"), T12 = await at("12:00"), T13 = await at("13:00");

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

// ------------------------------------------------------------------ invariants over the whole database
async function invariants(label) {
  const i1 = await one(`select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id
    and a.status in ('confirmed','pending') and b.status in ('confirmed','pending') and a.period && b.period`);
  const i2 = await one(`select count(*) from bookings k join blocks x on x.court_id = k.court_id and x.period && k.period where k.status in ('confirmed','pending')`);
  const i3 = await one(`select count(*) from payments p join bookings b on b.id = p.booking_id where
      (p.status = 'pending' and b.status <> 'pending')
   or (p.status = 'paid' and b.status not in ('confirmed','no_show','cancelled'))
   or (b.status = 'expired' and p.status = 'paid')`);
  const i4 = await one(`select (select count(*) from (select booking_id from payments group by booking_id having count(*) > 1) d)
    + (select count(*) from bookings b where b.source = 'staff' and (b.fee_usd <> 0 or exists (select 1 from payments p where p.booking_id = b.id)))`);
  const bad = { i1: Number(i1), i2: Number(i2), i3: Number(i3), i4: Number(i4) };
  if (FEE) {
    bad.i6 = Number(await one(`select count(*) from payment_attempts a where (a.status = 'succeeded') <> ((select count(*) from fee_charges c where c.attempt_id = a.id and c.reason is distinct from 'extra_charge') = 1)`))
      + Number(await one(`select count(*) from (select payment_id from payment_attempts where status in ('starting','open') group by 1 having count(*) > 1) d`));
    bad.i7 = Number(await one(`select count(*) from payments p where p.kind = 'fee_only' and (p.status = 'paid') <> ((select count(*) from fee_charges c where c.payment_id = p.id and c.disposition = 'kept') = 1)`))
      + Number(await one(`select count(*) from (select payment_id from fee_charges where disposition = 'kept' group by payment_id having count(*) > 1) d`));
    bad.i8 = Number(await one(`select count(*) from bookings b join payments p on p.booking_id = b.id where p.kind = 'fee_only' and b.status = 'confirmed'
      and not exists (select 1 from fee_charges c where c.payment_id = p.id and c.disposition = 'kept')`));
    bad.i9 = Number(await one(`select count(*) from fee_charges c where (c.attempt_id is null and c.reason is distinct from 'unmatched')
      or (c.disposition = 'refunded' and c.refund_reference is null)`))
      + Number(await one(`select count(*) from (select provider, refund_reference from fee_charges where refund_reference is not null group by 1, 2 having count(*) > 1) d`));
  }
  rep(`${label}: invariants ${FEE ? "I1–I4 and I6–I9" : "I1–I4"} hold`, Object.values(bad).every((v) => v === 0), JSON.stringify(bad));
}
const liveOn = async (court) => (await q("select status, source, player_id from bookings where court_id = $1 and status in ('confirmed','pending')", [court]));
const hold = (club, court, s, e) => ["select booking_id, payment_id, total_usd from hold_slot($1,$2,$3,$4)", [club, court, s, e]];

// ------------------------------------------------------------------ scenarios
const MODES = ["ab", "ba", "sim", "sim", "sim"];

async function exactlyOne(title, mk) {
  for (const mode of MODES) {
    const court = await newCourt();
    const [a, b] = mk(court);
    const [ra, rb] = await race(mode, a, b);
    const live = await liveOn(court);
    const blocks = Number(await one("select count(*) from blocks where court_id = $1", [court]));
    rep(`${title} [${mode}]: exactly one wins, the other is refused`, (ra.ok !== rb.ok) && live.length + blocks === 1, `${short(ra)} | ${short(rb)} | live=${live.length} blocks=${blocks}`);
  }
  await invariants(title);
}

// 1. two players, same court and time
await exactlyOne("S1 two players book the same court at the same time", (c) => [[P1, ...hold(CLUB, c, T10, T11)], [P2, ...hold(CLUB, c, T10, T11)]]);
// 1b. overlapping but not identical times
await exactlyOne("S1b two players, overlapping times (10:00–11:00 vs 10:30–11:30)", (c) => [[P1, ...hold(CLUB, c, T10, T11)], [P2, ...hold(CLUB, c, T1030, T1130)]]);
// 2. player versus staff walk-in
await exactlyOne("S2 player booking versus staff walk-in", (c) => [[P1, ...hold(CLUB, c, T10, T11)], [S1, "select staff_book($1,$2,$3,$4,'Walk-in Rami','03111111')", [CLUB, c, T10, T11]]]);
// 3. two staff at two desks
await exactlyOne("S3 two staff bookings for the same slot", (c) => [[S1, "select staff_book($1,$2,$3,$4,'Phone: Nadim',null)", [CLUB, c, T10, T11]], [S2, "select staff_book($1,$2,$3,$4,'WhatsApp: Joe',null)", [CLUB, c, T1030, T1130]]]);
// 4. court block versus new reservation (player, then staff)
await exactlyOne("S4 court block versus a player's reservation", (c) => [[S1, "select staff_block($1,$2,$3,$4,'Maintenance')", [CLUB, c, T10, T12]], [P1, ...hold(CLUB, c, T1030, T1130)]]);
await exactlyOne("S4b court block versus a staff walk-in", (c) => [[S1, "select staff_block($1,$2,$3,$4,'Maintenance')", [CLUB, c, T10, T12]], [S2, "select staff_book($1,$2,$3,$4,'Walk-in',null)", [CLUB, c, T11, T12]]]);
// 4c. whole-club closure versus a reservation (the closure covers every active court)
for (const mode of MODES) {
  const court = await newCourt();
  const day = 5 + MODES.indexOf(mode) + (mode === "sim" ? Math.floor(Math.random() * 3) : 0);   // its own day: closures cover every court
  const s = await at("15:00", day), e = await at("16:00", day), cs = await at("14:00", day), ce = await at("18:00", day);
  const [ra, rb] = await race(mode, [S1, "select close_club($1,$2,$3,'Closed for a tournament')", [CLUB, cs, ce]], [P1, ...hold(CLUB, court, s, e)]);
  const live = await liveOn(court);
  const blocks = Number(await one("select count(*) from blocks where court_id = $1 and period && tstzrange($2, $3)", [court, cs, ce]));
  rep(`S4c whole-club closure versus a reservation [${mode}]: never both`, (ra.ok !== rb.ok) && (live.length + blocks === 1), `${short(ra)} | ${short(rb)} | live=${live.length} blocks=${blocks}`);
  await q("delete from blocks where club_id = $1 and period && tstzrange($2, $3)", [CLUB, cs, ce]);
  await q("update payments set status = 'expired' where status = 'pending' and booking_id in (select id from bookings where court_id = $1)", [court]);
  await q("update bookings set status = 'cancelled' where court_id = $1 and status in ('confirmed','pending')", [court]);
}
await invariants("S4c");
// 5. move booking versus new reservation into the target slot
for (const mode of MODES) {
  const court = await newCourt();
  const moving = await one("select id from bookings where false");
  const [{ staff_book: id }] = (await (async () => { const s = await session(S1); const r = await s.run("select staff_book($1,$2,$3,$4,'Move me',null)", [CLUB, court, T12, T13]); await s.end(); return r.rows; })());
  void moving;
  const [ra, rb] = await race(mode, [S1, "select move_booking($1,$2,$3,$4)", [id, court, T10, T11]], [P1, ...hold(CLUB, court, T10, T11)]);
  const live = await q("select start_at from bookings where court_id = $1 and status in ('confirmed','pending') and period && tstzrange($2, $3)", [court, T10, T11]);
  rep(`S5 moving a booking into a slot versus a new reservation of it [${mode}]: exactly one gets it`, (ra.ok !== rb.ok) && live.length === 1, `${short(ra)} | ${short(rb)} | in slot=${live.length}`);
}
await invariants("S5");

if (FEE) await feeRaces();
else {
// 6. hold expiry versus a late payment confirmation, while another player takes the slot
for (const mode of MODES) {
  const court = await newCourt();
  const s = await session(P1); const h = (await s.run(...hold(CLUB, court, T10, T11).slice(0))).rows?.[0]; await s.end();
  await q("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [h.booking_id]);   // the hold ran out
  const [ra, rb] = await race(mode, ["service", "select confirm_payment($1, $2, $3)", [h.payment_id, `ref-late-${mode}-${court}`, h.total_usd]], [P2, ...hold(CLUB, court, T10, T11)]);
  const b1 = await q("select b.status as booking, p.status as payment from bookings b join payments p on p.booking_id = b.id where b.id = $1", [h.booking_id]);
  const live = await liveOn(court);
  // either the late payment confirms the still-held slot (P2 refused), or P2's hold swept it first (payment owed back)
  const okA = ra.ok && ra.rows[0].confirm_payment === "confirmed" && !rb.ok && b1[0].booking === "confirmed";
  const okB = ra.ok && ra.rows[0].confirm_payment === "refund_due" && rb.ok && b1[0].booking === "expired" && b1[0].payment === "refund_due";
  rep(`S6 expired hold versus late confirmation and a new booking [${mode}]: one owner, money owed back if late`, (okA || okB) && live.length === 1,
    `${short(ra)}=${ra.rows?.[0]?.confirm_payment} | ${short(rb)} | ${JSON.stringify(b1[0])} live=${live.length}`);
}
await invariants("S6");
// 6a. the same without any race (0090's regression): a confirmation that arrives after the hold's deadline, with nobody
//     else on the court, confirms the booking (the hold still owns the slot) instead of failing
{
  const court = await newCourt();
  let s = await session(P1); const h = (await s.run(...hold(CLUB, court, T10, T11))).rows[0]; await s.end();
  await q("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [h.booking_id]);
  s = await session("service"); const r = await s.run("select confirm_payment($1,$2,$3)", [h.payment_id, `ref-late-alone-${court}`, h.total_usd]); await s.end();
  const st = (await q("select b.status as booking, p.status as payment, b.hold_expires_at from bookings b join payments p on p.booking_id = b.id where b.id = $1", [h.booking_id]))[0];
  rep("S6a a late confirmation with nobody else on the court confirms the booking (was: internal error, money unrecorded)",
    r.ok && r.rows[0].confirm_payment === "confirmed" && st.booking === "confirmed" && st.payment === "paid" && st.hold_expires_at === null, `${short(r)} ${JSON.stringify(st)}`);
  // and a second, older expired hold on the same court is still swept by that confirmation's check
  const court2 = await newCourt();
  s = await session(P1); const a = (await s.run(...hold(CLUB, court2, T10, T11))).rows[0]; await s.end();
  s = await session(P2); const b = (await s.run(...hold(CLUB, court2, T12, T13))).rows[0]; await s.end();
  await q("update bookings set hold_expires_at = now() - interval '1 minute' where id = any($1)", [[a.booking_id, b.booking_id]]);
  s = await session("service"); const r2 = await s.run("select confirm_payment($1,$2,$3)", [a.payment_id, `ref-late-two-${court2}`, a.total_usd]); await s.end();
  const other = await one("select status from bookings where id = $1", [b.booking_id]);
  rep("S6a ...and the court's other expired holds are still freed by it", r2.ok && other === "expired", `${short(r2)} other=${other}`);
}
// 6b. failed payment and expired hold do not consume availability
{
  const court = await newCourt();
  let s = await session(P1); let h = (await s.run(...hold(CLUB, court, T10, T11))).rows[0]; await s.end();
  s = await session("service"); await s.run("select fail_payment($1, 'card declined')", [h.payment_id]); await s.end();
  s = await session(P2); const after1 = await s.run(...hold(CLUB, court, T10, T11)); await s.end();
  rep("S6b a failed payment frees the slot at once", after1.ok, short(after1));
  const court2 = await newCourt();
  s = await session(P1); h = (await s.run(...hold(CLUB, court2, T10, T11))).rows[0]; await s.end();
  await q("update bookings set hold_expires_at = now() - interval '1 second' where id = $1", [h.booking_id]);
  s = await session(S1); const after2 = await s.run("select staff_book($1,$2,$3,$4,'Walk-in after expiry',null)", [CLUB, court2, T10, T11]); await s.end();
  rep("S6b an expired hold (not yet swept) does not block a staff walk-in", after2.ok, short(after2));
  const court3 = await newCourt();
  s = await session(P1); h = (await s.run(...hold(CLUB, court3, T10, T11))).rows[0]; await s.end();
  await q("update bookings set hold_expires_at = now() - interval '1 second' where id = $1", [h.booking_id]);
  s = await session(S1); const after3 = await s.run("select staff_block($1,$2,$3,$4,'Maintenance')", [CLUB, court3, T10, T11]); await s.end();
  rep("S6b an expired hold does not block a court block", after3.ok, short(after3));
  const st = await q("select status from bookings where id = $1", [h.booking_id]);
  rep("S6b ...and the expired hold is recorded as expired, its payment too",
    st[0].status === "expired" && (await one("select status from payments where booking_id = $1", [h.booking_id])) === "expired");
  await invariants("S6b");
}

// 7. cancellation versus payment confirmation of the same pending booking
for (const mode of MODES) {
  const court = await newCourt();
  const s = await session(P1); const h = (await s.run(...hold(CLUB, court, T10, T11))).rows[0]; await s.end();
  const [ra, rb] = await race(mode, [P1, "select cancel_booking($1)", [h.booking_id]], ["service", "select confirm_payment($1,$2,$3)", [h.payment_id, `ref-cx-${mode}-${court}`, h.total_usd]]);
  const r = (await q("select b.status as booking, p.status as payment from bookings b join payments p on p.booking_id = b.id where b.id = $1", [h.booking_id]))[0];
  // cancel first: cancelled + money owed back; confirm first: then cancelled before cutoff → refund_due as well
  const ok = ra.ok && rb.ok && r.booking === "cancelled" && r.payment === "refund_due";
  const okConfirmOnly = !ra.ok && rb.ok && r.booking === "confirmed" && r.payment === "paid";
  rep(`S7 cancellation versus confirmation [${mode}]: cancelled with the money owed back (never cancelled-and-kept)`, ok || okConfirmOnly,
    `${short(ra)} | ${short(rb)}=${rb.rows?.[0]?.confirm_payment} | ${JSON.stringify(r)}`);
}
await invariants("S7");

// 8. duplicate payment callbacks / confirmation requests
for (const mode of MODES) {
  const court = await newCourt();
  const s = await session(P1); const h = (await s.run(...hold(CLUB, court, T10, T11))).rows[0]; await s.end();
  const ref = `ref-dup-${mode}-${court}`;
  const [ra, rb] = await race(mode, ["service", "select confirm_payment($1,$2,$3)", [h.payment_id, ref, h.total_usd]], ["service", "select confirm_payment($1,$2,$3)", [h.payment_id, ref, h.total_usd]]);
  const answers = [ra.rows?.[0]?.confirm_payment, rb.rows?.[0]?.confirm_payment].sort();
  const p = (await q("select status, provider_ref from payments where booking_id = $1", [h.booking_id]))[0];
  rep(`S8 the same confirmation twice [${mode}]: confirmed once, the repeat says already_paid`, JSON.stringify(answers) === JSON.stringify(["already_paid", "confirmed"]) && p.status === "paid",
    `${JSON.stringify(answers)} ${JSON.stringify(p)}`);
}
{
  const court = await newCourt();
  const s = await session(P1); const h = (await s.run(...hold(CLUB, court, T10, T11))).rows[0]; await s.end();
  const [ra, rb] = await race("sim", ["service", "select confirm_payment($1,$2,$3)", [h.payment_id, "ref-x1", h.total_usd]], ["service", "select confirm_payment($1,$2,$3)", [h.payment_id, "ref-x2", h.total_usd]]);
  rep("S8b two different receipts for one payment: one confirms, the other is refused as a mismatch", (ra.ok !== rb.ok) && /payment_mismatch/.test((ra.ok ? rb : ra).err), `${short(ra)} | ${short(rb)}`);
  const usedRef = await one("select provider_ref from payments where id = $1", [h.payment_id]);
  const court2 = await newCourt();
  const s2 = await session(P2); const h2 = (await s2.run(...hold(CLUB, court2, T10, T11))).rows[0]; await s2.end();
  const r3 = await (async () => { const x = await session("service"); const r = await x.run("select confirm_payment($1,$2,$3)", [h2.payment_id, usedRef, h2.total_usd]); await x.end(); return r; })();
  rep("S8c one receipt cannot pay for two bookings", !r3.ok && /duplicate_provider_ref/.test(r3.err), short(r3));
  const r4 = await (async () => { const x = await session("service"); const r = await x.run("select confirm_payment($1,$2,$3)", [h2.payment_id, "ref-x3", Number(h2.total_usd) - 1]); await x.end(); return r; })();
  const st4 = await one("select status from payments where id = $1", [h2.payment_id]);
  rep("S8d a receipt for the wrong amount is refused, and the payment stays unpaid", !r4.ok && /amount_mismatch/.test(r4.err) && st4 === "pending", `${short(r4)} ${st4}`);
}
await invariants("S8");

// 9. refund-due bookkeeping: completing the same refund twice at once records it once
for (const mode of MODES) {
  const court = await newCourt();
  let s = await session(P1); const h = (await s.run(...hold(CLUB, court, T10, T11))).rows[0]; await s.end();
  await q("update payments set provider = 'whish' where id = $1", [h.payment_id]);   // real money (simulated money is never refunded)
  s = await session("service"); await s.run("select confirm_payment($1,$2,$3)", [h.payment_id, `ref-rf-${mode}-${court}`, h.total_usd]); await s.end();
  s = await session(P1); const cx = await s.run("select cancel_booking($1)", [h.booking_id]); await s.end();
  const due = await one("select status from payments where id = $1", [h.payment_id]);
  const [ra, rb] = await race(mode, [S1, "select mark_refunded($1)", [h.payment_id]], [S2, "select mark_refunded($1)", [h.payment_id]]);
  const p = (await q("select status, refunded_at is not null as dated from payments where id = $1", [h.payment_id]))[0];
  rep(`S9 refund owed after a cancellation, completed by two staff at once [${mode}]: refunded once`, cx.ok && due === "refund_due" && p.status === "refunded" && (ra.ok || rb.ok),
    `cancel=${short(cx)} due=${due} | ${short(ra)} | ${short(rb)} | ${JSON.stringify(p)}`);
}
await invariants("S9");

}

// ------------------------------------------------------------------ M12.1 fee-only races (FEE=1)
async function feeRaces() {
  const ADMIN = U(6);
  await q("insert into auth.users (id, phone) values ($1,'+96170000006') on conflict do nothing", [ADMIN]);
  await q("update profiles set roles = '{player,admin}', rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = $1", [ADMIN]);
  let key = 0;
  const newKey = () => `f1a00000-0000-4000-8000-${String(++key).padStart(12, "0")}`;
  const solo = async (who, sql, args) => { const s = await session(who); const r = await s.run(sql, args); await s.end(); return r; };
  const holdAs = async (who, court, s = T10, e = T11) => { const r = await solo(who, ...hold(CLUB, court, s, e)); if (!r.ok) throw new Error(`hold: ${r.err}`); return r.rows[0]; };
  const attempt = async (who, pay) => (await solo(who, "select attempt_id from start_payment_attempt($1, $2)", [pay, newKey()])).rows[0].attempt_id;
  const result = (a, ref, amount = 1) => ["service", "select record_attempt_result($1, 'succeeded', $2, $3, 'USD') as r", [a, ref, amount]];
  const out = (r) => (r.ok ? r.rows[0].r ?? r.rows[0].reconcile_provider_charge ?? r.rows[0].complete_fee_refund : short(r));
  const charges = async (pay) => (await q("select disposition || coalesce(':' || reason, '') x from fee_charges where payment_id = $1 order by 1", [pay])).map((r) => r.x).join(",");
  const state = async (bk) => (await q("select b.status as booking, p.status as payment from bookings b join payments p on p.booking_id = b.id where b.id = $1", [bk]))[0];

  // F6. the hold has run out; its late success races another player taking the slot
  for (const mode of MODES) {
    const court = await newCourt();
    const h = await holdAs(P1, court);
    const a = await attempt(P1, h.payment_id);
    await q("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [h.booking_id]);
    const [ra, rb] = await race(mode, result(a, `F6-${mode}-${court}`), [P2, ...hold(CLUB, court, T10, T11)]);
    const st = await state(h.booking_id); const live = await liveOn(court);
    const okA = out(ra) === "confirmed" && !rb.ok && st.booking === "confirmed";
    const okB = out(ra) === "late" && rb.ok && st.booking === "expired" && st.payment === "refund_due" && (await charges(h.payment_id)) === "refund_due:not_confirmed";
    rep(`F6 expired hold: late fee success versus a new booking [${mode}]: one owner; a late charge is recorded and owed back`, (okA || okB) && live.length === 1,
      `${out(ra)} | ${short(rb)} | ${JSON.stringify(st)} live=${live.length}`);
  }
  await invariants("F6");

  // F7. the player cancels the hold while the fee succeeds
  for (const mode of MODES) {
    const court = await newCourt();
    const h = await holdAs(P1, court);
    const a = await attempt(P1, h.payment_id);
    const [ra, rb] = await race(mode, [P1, "select cancel_booking($1)", [h.booking_id]], result(a, `F7-${mode}-${court}`));
    const st = await state(h.booking_id); const ch = await charges(h.payment_id);
    // cancel first: the success is late (owed back). Success first: confirmed, then the player's cancellation keeps the fee.
    const ok = ra.ok && st.booking === "cancelled" && ((out(rb) === "late" && ch === "refund_due:not_confirmed") || (out(rb) === "confirmed" && ch === "kept" && st.payment === "paid"));
    rep(`F7 player cancels while the fee succeeds [${mode}]: the charge is always recorded (kept after a confirmed booking, owed back otherwise)`, ok,
      `${short(ra)} | ${out(rb)} | ${JSON.stringify(st)} ${ch}`);
  }
  await invariants("F7");

  // F8. the same success delivered twice at once (callback + return page), and callback + reconciliation
  for (const mode of MODES) {
    const court = await newCourt();
    const h = await holdAs(P1, court);
    const a = await attempt(P1, h.payment_id);
    const ref = `F8-${mode}-${court}`;
    const second = mode === "sim" ? ["service", "select reconcile_provider_charge('simulated', $1, $2, 1, 'USD') as r", [a, ref]] : result(a, ref);
    const [ra, rb] = await race(mode, result(a, ref), second);
    const answers = [out(ra), out(rb)].sort();
    rep(`F8 the same success twice at once${mode === "sim" ? " (callback + reconciliation)" : ""} [${mode}]: confirmed once, one charge`,
      JSON.stringify(answers) === JSON.stringify(["already_recorded", "confirmed"]) && (await charges(h.payment_id)) === "kept", `${JSON.stringify(answers)} ${await charges(h.payment_id)}`);
  }
  // F8b. two different attempts both succeed at once (the first had been given up on as expired: only one attempt may
  //      be unresolved at a time, so this is the only way two can be live with the provider)
  for (const mode of MODES) {
    const court = await newCourt();
    const h = await holdAs(P1, court);
    const a1 = await attempt(P1, h.payment_id);
    await solo("service", "select record_attempt_result($1, 'expired')", [a1]);
    const a2 = await attempt(P1, h.payment_id);
    const [ra, rb] = await race(mode, result(a1, `F8b-1-${mode}-${court}`), result(a2, `F8b-2-${mode}-${court}`));
    const answers = [out(ra), out(rb)].sort();
    rep(`F8b two attempts succeed at once [${mode}]: one confirms, the other is a duplicate owed back`,
      JSON.stringify(answers) === JSON.stringify(["confirmed", "duplicate"]) && (await charges(h.payment_id)) === "kept,refund_due:duplicate", `${JSON.stringify(answers)} ${await charges(h.payment_id)}`);
  }
  await invariants("F8");

  // F9. an admin's refund completed twice at once (two tabs): recorded once
  for (const mode of MODES) {
    const court = await newCourt();
    const h = await holdAs(P1, court);
    await q("update payments set provider = 'whish' where id = $1", [h.payment_id]);   // real money
    const a = await attempt(P1, h.payment_id);
    await solo(...result(a, `F9-${mode}-${court}`));
    await solo(S1, "select cancel_booking($1, true)", [h.booking_id]);                  // club-caused: owed back
    const c = await one("select id from fee_charges where payment_id = $1", [h.payment_id]);
    const done = (ref) => [ADMIN, "select complete_fee_refund($1, 1, 'provider_portal', $2)", [c, ref]];
    const [ra, rb] = await race(mode, done(`WR-${mode}-${court}`), done(`WR-${mode}-${court}`));
    const answers = [out(ra), out(rb)].sort();
    const st = (await q("select disposition, refund_reference from fee_charges where id = $1", [c]))[0];
    rep(`F9 a fee refund completed twice at once [${mode}]: refunded once`, JSON.stringify(answers) === JSON.stringify(["already_refunded", "refunded"]) && st.disposition === "refunded",
      `${JSON.stringify(answers)} ${JSON.stringify(st)}`);
  }
  await invariants("F9");

  // F10. the club cancels the hold while the fee succeeds
  for (const mode of MODES) {
    const court = await newCourt();
    const h = await holdAs(P1, court);
    const a = await attempt(P1, h.payment_id);
    const [ra, rb] = await race(mode, [S1, "select cancel_booking($1, true)", [h.booking_id]], result(a, `F10-${mode}-${court}`));
    const st = await state(h.booking_id); const ch = await charges(h.payment_id);
    const ok = ra.ok && st.booking === "cancelled" && ((out(rb) === "late" && ch === "refund_due:not_confirmed") || (out(rb) === "confirmed" && ch === "refund_due:club_cancelled"));
    rep(`F10 the club cancels while the fee succeeds [${mode}]: the fee is always owed back`, ok, `${short(ra)} | ${out(rb)} | ${JSON.stringify(st)} ${ch}`);
  }
  await invariants("F10");

  // F11. four "pay" taps at once with different keys (a page reloaded, two tabs), and two with the same key
  {
    const court = await newCourt();
    const h = await holdAs(P1, court);
    const sessions = await Promise.all([0, 1, 2, 3].map(() => session(P1)));
    const keys = [newKey(), newKey(), newKey(), newKey()];
    const rs = await Promise.all(sessions.map((s, i) => s.run("select attempt_no from start_payment_attempt($1, $2)", [h.payment_id, keys[i]]).then(async (r) => { await s.end(); return r; })));
    const made = Number(await one("select count(*) from payment_attempts where payment_id = $1", [h.payment_id]));
    rep("F11 four simultaneous taps with different keys: ONE attempt is made, the other three are refused (attempt_in_progress)",
      made === 1 && rs.filter((r) => !r.ok && /attempt_in_progress/.test(r.err)).length === 3, `made=${made} ${rs.map(short).join(" | ")}`);
    const court2 = await newCourt();
    const h2 = await holdAs(P2, court2);
    const k = newKey();
    const [ra, rb] = await race("sim", [P2, "select attempt_id, already from start_payment_attempt($1, $2)", [h2.payment_id, k]], [P2, "select attempt_id, already from start_payment_attempt($1, $2)", [h2.payment_id, k]]);
    const made2 = Number(await one("select count(*) from payment_attempts where payment_id = $1", [h2.payment_id]));
    rep("F11 the same request twice at once: one attempt, both answers name it", ra.ok && rb.ok && made2 === 1 && ra.rows[0].attempt_id === rb.rows[0].attempt_id,
      `${short(ra)} | ${short(rb)} made=${made2}`);
  }
  // F12. a tap while the first attempt's provider call is still running (delayed provider): refused, never a second
  //      attempt; once the provider answers "expired", the next tap gets attempt 2
  for (const mode of MODES) {
    const court = await newCourt();
    const h = await holdAs(P2, court);
    const a1 = await attempt(P2, h.payment_id);                                    // 'starting': the provider has not answered
    const [ra, rb] = await race(mode, [P2, "select attempt_no from start_payment_attempt($1, $2)", [h.payment_id, newKey()]],
      ["service", "select open_payment_attempt($1, 'https://pay.example/slow', 's') as r", [a1]]);
    const made = Number(await one("select count(*) from payment_attempts where payment_id = $1", [h.payment_id]));
    await solo("service", "select record_attempt_result($1, 'expired')", [a1]);
    const next = await solo(P2, "select attempt_no from start_payment_attempt($1, $2)", [h.payment_id, newKey()]);
    rep(`F12 a second tap while the provider is slow [${mode}]: refused, one attempt; after the provider says expired, attempt 2`,
      !ra.ok && /attempt_in_progress/.test(ra.err) && rb.ok && made === 1 && next.ok && next.rows[0].attempt_no === 2, `${short(ra)} | ${short(rb)} made=${made} next=${short(next)}`);
  }
  // F13. the provider's transaction records and its callback race on the same unpaid attempt with two different charges
  for (const mode of MODES) {
    const court = await newCourt();
    const h = await holdAs(P1, court);
    const a = await attempt(P1, h.payment_id);
    const [ra, rb] = await race(mode, result(a, `F13-cb-${mode}-${court}`),
      ["service", "select reconcile_provider_charge('simulated', $1, $2, 1, 'USD') as r", [a, `F13-rec-${mode}-${court}`]]);
    const st = await state(h.booking_id); const ch = await charges(h.payment_id);
    // callback first: confirmed, then the records' second charge is an extra charge owed back.
    // records first: confirmed by them, then the callback's different charge is refused (a callback cannot add one).
    const okA = out(ra) === "confirmed" && out(rb) === "extra_charge";
    const okB = out(rb) === "confirmed" && !ra.ok && /attempt_evidence_conflict/.test(ra.err);
    rep(`F13 provider records versus callback, two charges on one attempt [${mode}]: confirmed once, never two kept charges`,
      (okA || okB) && st.booking === "confirmed" && (ch === "kept,refund_due:extra_charge" || ch === "kept"), `${out(ra)} | ${out(rb)} | ${ch}`);
  }
  await invariants("F11");
}

const left = await one("select count(*) from bookings where status = 'pending' and hold_expires_at < now() - interval '1 hour'");
void left;
console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
await admin.end();
process.exit(fails ? 1 : 0);
