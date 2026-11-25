// 0093 (pilot): a closed account's booking versus its deletion, its closure and an older app's request — on a scratch
// copy of the local test database (closed_account_booking.sh makes it, instruments it and drops it).
//
// Deterministic orderings use a gate the .sh adds to book_at_desk / hold_slot in the scratch copy only: when the
// session sets test.gate, the function waits on advisory lock 4242 (held by this driver) at that point:
//   before_lock  right before the profile row lock
//   after_lock   right after the profile row lock, before the closed-account check
//   after_check  right before lock_courts (after the check)
// The functions' logic is otherwise exactly what the migration defines (or, with CONTROL, what it replaced).
// Env: DB, PG_MODULE, N (random races per kind, default 60), CONTROL = "" | "all" (0093 rolled back) | "rad" (only
// request_account_deletion rolled back). Under CONTROL the deadlock checks are expected to FAIL (they show what 0093 fixes).
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const DB = process.env.DB, N = Number(process.env.N ?? 60), CONTROL = process.env.CONTROL ?? "";
let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${JSON.stringify(detail)}]`); } };
const admin = new Client({ connectionString: DB }); await admin.connect();
const q = async (s, a = []) => (await admin.query(s, a)).rows;
const one = async (s, a = []) => Object.values((await q(s, a))[0] ?? {})[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESK = await one("select id from clubs where slug = 'other'");
await q("update clubs set payment_mode = 'at_desk', max_upcoming_bookings = 20, active = true where id = $1", [DESK]);
const DEMO = await one("select id from clubs where slug = 'batroun' and is_demo");
await q("update clubs set payment_mode = 'simulated', max_upcoming_bookings = 20, active = true where id = $1", [DEMO]);
// the deletion worker's heartbeat (0086: closing is refused unless the worker ran within the hour), renewed per race
const heartbeat = () => q("select record_deletion_worker_run('{}'::jsonb)");
await heartbeat();
const U = (n) => `e8000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let n = 0, cn = 0;
const at = async (hh, d) => one(`select ((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut'`, [hh]);
const court = async (club) => {
  const id = await one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 960) returning id", [club, `zz-cb-${++cn}`]);
  await q("insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ($1, $2, 127, '00:00', '23:59', 20, 'cb') on conflict do nothing", [club, id]).catch(() => {});
  return id;
};

/** A session in its own transaction, as the service (deletion worker) or as a signed-in person. */
async function sess(who, gate = null) {
  const c = new Client({ connectionString: DB }); await c.connect(); await c.query("begin");
  c.pid = (await c.query("select pg_backend_pid() p")).rows[0].p;
  if (who === "service") await c.query("set local role service_role");
  else {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [who, JSON.stringify({ sub: who, role: "authenticated", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }] })]);
  }
  if (gate) await c.query("select set_config('test.gate', $1, true)", [gate]);
  return c;
}
/** Runs one statement and ends the transaction (commit on success). Resolves to "ok" or the error message. */
async function run(c, sql, args = []) {
  let r; try { await c.query(sql, args); r = "ok"; } catch (e) { r = e.message; }
  try { await c.query(r === "ok" ? "commit" : "rollback"); } catch { /* aborted */ }
  await c.end(); return r;
}
/** Waits until a session is blocked on a lock (of the given kind, if given). */
async function waiting(c, kinds = null, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = (await q("select wait_event_type, wait_event from pg_stat_activity where pid = $1", [c.pid]))[0];
    if (r?.wait_event_type === "Lock" && (!kinds || kinds.includes(r.wait_event))) return r.wait_event;
    await sleep(5);
  }
  return null;
}
const GATE = 4242;
const gate = { c: null, async close() { this.c = new Client({ connectionString: DB }); await this.c.connect(); await this.c.query("select pg_advisory_lock($1)", [GATE]); },
  async open() { await this.c.query("select pg_advisory_unlock($1)", [GATE]); await this.c.end(); } };

const BOOK = { desk: "select 1 from book_at_desk($2, $3, $4, gen_random_uuid()) where $1::uuid is not null",
               demo: "select 1 from hold_slot($1, $2, $3, $4, gen_random_uuid())" };
const CLUB = { desk: DESK, demo: DEMO };
const DELETE = "select delete_account_data($1, false)";

/** A person with live bookings on two courts (desk: both confirmed; demo: a new hold expires the earlier one, so only c2's
 *  hold is live). The races use c2, a court the deletion locks first. state: open | closed. */
async function person(kind, state) {
  await heartbeat();
  const p = U(++n);
  await q("insert into auth.users (id, phone) values ($1, $2)", [p, `+9617180${String(n).padStart(4, "0")}`]);
  await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = $1", [p]);
  const c1 = await court(CLUB[kind]), c2 = await court(CLUB[kind]);
  for (const [c, d] of [[c1, 5], [c2, 6]]) {
    const r = await run(await sess(p), BOOK[kind], [CLUB[kind], c, await at("10:00", d), await at("11:00", d)]);
    if (r !== "ok") throw new Error(`setup booking: ${r}`);
  }
  if (state === "closed") await q("insert into account_deletions (subject_id, requested_via, status, closing_at) values ($1, 'app', 'closed', now())", [p]);
  return { p, c1, c2 };
}
const closureRaced = [];   // subjects of the random closure races: their booking may legitimately begin after the closure's transaction
const slot = async () => [await at("14:00", 5), await at("15:00", 5)];
const live = async (p) => Number(await one("select count(*) from bookings where player_id = $1 and status in ('confirmed', 'pending')", [p]));
const deadlock = (rs) => rs.some((r) => /deadlock/.test(r));
const isRefusal = (r) => /account_closed|account_deletion_requested/.test(r);

// ---------------------------------------------------------------- deterministic orderings
const REPEAT = 5;
for (const kind of ["desk", "demo"]) {
  const fn = kind === "desk" ? "book_at_desk" : "hold_slot";

  // O1 the booking holds the profile row first; the deletion then takes the courts and waits for that row
  let o1 = { deadlocks: 0, bad: [] };
  for (let i = 0; i < REPEAT; i++) {
    const f = await person(kind, "closed"); const [s, e] = await slot();
    await gate.close();
    const b = await sess(f.p, "after_lock"); const bP = run(b, BOOK[kind], [CLUB[kind], f.c2, s, e]);
    const bw = await waiting(b, ["advisory"]);
    const d = await sess("service"); const dP = run(d, DELETE, [f.p]);
    const dw = await waiting(d, ["tuple", "transactionid"]);
    await gate.open();
    const [br, dr] = await Promise.all([bP, dP]);
    if (deadlock([br, dr])) o1.deadlocks++;
    if (!(bw && dw && isRefusal(br) && dr === "ok" && (await live(f.p)) === 0)) o1.bad.push({ bw, dw, br: br.slice(0, 40), dr: dr.slice(0, 40) });
  }
  if (CONTROL === "all") rep(`CONTROL O1 ${fn}: booking holds the profile, deletion holds the courts → the old definitions deadlock`, o1.deadlocks > 0, o1);
  else rep(`O1 ${fn}: booking holds the profile first, deletion then takes the courts → booking refused under the lock, deletion succeeds, no deadlock (x${REPEAT})`,
    o1.deadlocks === 0 && o1.bad.length === 0, o1);

  // O2 the deletion holds the courts first and waits for the profile row; the booking arrives after it
  let o2 = { deadlocks: 0, bad: [] };
  for (let i = 0; i < REPEAT; i++) {
    const f = await person(kind, "closed"); const [s, e] = await slot();
    const x = await sess("service"); await x.query("select 1 from profiles where id = $1 for update", [f.p]);   // holds the row
    const d = await sess("service"); const dP = run(d, DELETE, [f.p]);
    const dw = await waiting(d, ["tuple", "transactionid"]);
    const b = await sess(f.p); const bP = run(b, BOOK[kind], [CLUB[kind], f.c2, s, e]);
    const bw = await waiting(b, ["tuple", "transactionid"]);
    await x.query("commit"); await x.end();
    const [br, dr] = await Promise.all([bP, dP]);
    if (deadlock([br, dr])) o2.deadlocks++;
    if (!(dw && bw && isRefusal(br) && dr === "ok" && (await live(f.p)) === 0)) o2.bad.push({ dw, bw, br: br.slice(0, 40), dr: dr.slice(0, 40) });
  }
  if (CONTROL !== "all") rep(`O2 ${fn}: deletion holds the courts first, booking arrives → booking refused, deletion succeeds, no deadlock (x${REPEAT})`,
    o2.deadlocks === 0 && o2.bad.length === 0, o2);

  if (CONTROL) continue;
  // O3 an OPEN account: the booking holds the profile row; the person closes their account meanwhile (waits)
  let o3 = { bad: [] };
  for (let i = 0; i < REPEAT; i++) {
    const f = await person(kind, "open"); const [s, e] = await slot();
    await gate.close();
    const b = await sess(f.p, "after_lock"); const bP = run(b, BOOK[kind], [CLUB[kind], f.c2, s, e]);
    const bw = await waiting(b, ["advisory"]);
    const c = await sess(f.p); const cP = run(c, "select close_my_account('app')");
    const cw = await waiting(c, ["tuple", "transactionid"]);
    await gate.open();
    const [br, cr] = await Promise.all([bP, cP]);
    const order = await one(`select bool_and(b.created_at < d.closing_at) from bookings b join account_deletions d on d.subject_id = b.player_id
                             where b.player_id = $1 and d.status in ('closing', 'held')`, [f.p]);
    const dr = await run(await sess("service"), DELETE, [f.p]);
    if (!(bw && cw && br === "ok" && cr === "ok" && order === true && dr === "ok" && (await live(f.p)) === 0)) o3.bad.push({ bw, cw, br, cr, order, dr });
  }
  rep(`O3 ${fn}: open account, booking holds the profile, closure waits → booking lands BEFORE the closure, the deletion then cancels it; nothing live after (x${REPEAT})`, o3.bad.length === 0, o3);

  // O4 the closure commits first; then the booking → refused
  let o4 = { bad: [] };
  for (let i = 0; i < REPEAT; i++) {
    const f = await person(kind, "open"); const [s, e] = await slot();
    const cr = await run(await sess(f.p), "select close_my_account('app')");
    const br = await run(await sess(f.p), BOOK[kind], [CLUB[kind], f.c2, s, e]);
    const after = Number(await one("select count(*) from bookings where player_id = $1 and start_at = $2", [f.p, s]));
    if (!(cr === "ok" && /account_closed/.test(br) && after === 0)) o4.bad.push({ cr, br, after });
  }
  rep(`O4 ${fn}: closure committed first → booking refused with account_closed before any court is locked; no row (x${REPEAT})`, o4.bad.length === 0, o4);
}

// O6 the closure commits between the moment the booking starts and the moment it takes the profile row (the window an
// UNLOCKED check would miss): the booking is gated just before its profile lock while the person closes the account.
// With 0093 the check runs after the lock, sees the closure and refuses with account_closed, without waiting for a
// court. (MUTANT=unlocked: the check already passed before the lock, so the booking goes on to the courts and is only
// stopped by the insert trigger — a different error, after queueing for a court: this check fails.)
if (!CONTROL) for (const kind of ["desk", "demo"]) {
  const fn = kind === "desk" ? "book_at_desk" : "hold_slot";
  let o6 = { bad: [] };
  for (let i = 0; i < REPEAT; i++) {
    const f = await person(kind, "open"); const [s, e] = await slot();
    await gate.close();
    const b = await sess(f.p, "before_lock"); const bP = run(b, BOOK[kind], [CLUB[kind], f.c2, s, e]);
    const bw = await waiting(b, ["advisory"]);
    const cr = await run(await sess(f.p), "select close_my_account('app')");   // commits while the booking is gated
    const x = await sess("service"); await x.query("select 1 from courts where id = $1 for update", [f.c2]);   // the court is busy
    await gate.open();
    const courtWait = await waiting(b, ["tuple", "transactionid"], 800);   // does the booking queue for the court?
    await x.query("commit"); await x.end();
    const br = await bP;
    if (!(bw && cr === "ok" && /account_closed/.test(br) && !courtWait)) o6.bad.push({ bw, cr, br: br.slice(0, 50), courtWait });
  }
  rep(`O6 ${fn}: closure committed just before the booking takes the profile row → the check under the lock sees it: account_closed, no court wait (x${REPEAT})`, o6.bad.length === 0, o6);
}

// O5 an older app's request (request_account_deletion) arriving while a booking that already PASSED its check holds the
// profile row. With 0093 the request waits for the row, so no deletion record exists until the booking commits; the
// deletion then runs and cancels the booking. Without 0093's request lock (CONTROL=rad or all) the request commits at
// once, a deletion run can start on it, take the courts and wait for the row → deadlock when the booking reaches them.
for (const kind of ["desk"]) {
  let o5 = { deadlocks: 0, bad: [] };
  for (let i = 0; i < REPEAT; i++) {
    const f = await person(kind, "open"); const [s, e] = await slot();
    await gate.close();
    const b = await sess(f.p, "after_check"); const bP = run(b, BOOK[kind], [CLUB[kind], f.c2, s, e]);
    const bw = await waiting(b, ["advisory"]);
    const r = await sess(f.p); const rP = run(r, "select request_account_deletion('app')");
    const rw = await waiting(r, ["tuple", "transactionid"], 1500);   // with 0093: the request waits for the row
    let dP = null, dw = null;
    if (!rw) {   // the request went through (old definition): a deletion run starts on it while the booking is gated
      const rr = await rP;
      if (rr === "ok") { const d = await sess("service"); dP = run(d, DELETE, [f.p]); dw = await waiting(d, ["tuple", "transactionid"]); }
    }
    await gate.open();
    const br = await bP, rr = await rP, dr = dP ? await dP : await run(await sess("service"), DELETE, [f.p]);
    if (deadlock([br, rr, dr])) o5.deadlocks++;
    if (!(bw && rw && br === "ok" && rr === "ok" && dr === "ok" && (await live(f.p)) === 0)) o5.bad.push({ bw, rw, dw, br: br.slice(0, 40), rr: rr.slice(0, 40), dr: dr.slice(0, 40) });
  }
  if (CONTROL) rep(`CONTROL O5 book_at_desk: without the request's profile lock, a request overtakes a checked booking → deadlock`, o5.deadlocks > 0, o5);
  else rep(`O5 book_at_desk: an older app's request waits for the profile row held by a checked booking → booking first, deletion cancels it, no deadlock (x${REPEAT})`,
    o5.deadlocks === 0 && o5.bad.length === 0, o5);
}

// ---------------------------------------------------------------- random races (both orders), with a competitor
if (!CONTROL) {
  for (const kind of ["desk", "demo"]) {
    const fn = kind === "desk" ? "book_at_desk" : "hold_slot";
    for (const lead of ["deletion", "booking"]) {
      let st = { deadlocks: 0, deletionFailed: 0, closedBooked: 0, competitor: {}, both: 0, other: {} };
      for (let i = 0; i < N; i++) {
        const f = await person(kind, "closed"); const [s, e] = await slot();
        const rival = U(++n);
        await q("insert into auth.users (id, phone) values ($1, $2)", [rival, `+9617181${String(n).padStart(4, "0")}`]);
        await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = $1", [rival]);
        const [d, b, r] = [await sess("service"), await sess(f.p), await sess(rival)];
        const jitter = () => sleep(Math.random() * 3);
        const dP = (async () => { if (lead === "booking") await jitter(); return run(d, DELETE, [f.p]); })();
        const bP = (async () => { if (lead === "deletion") await jitter(); return run(b, BOOK[kind], [CLUB[kind], f.c2, s, e]); })();
        const rP = (async () => { await jitter(); return run(r, BOOK[kind], [CLUB[kind], f.c2, s, e]); })();   // the same slot, an open account
        const [dr, br, rr] = await Promise.all([dP, bP, rP]);
        if (deadlock([dr, br, rr])) st.deadlocks++;
        if (dr !== "ok") st.deletionFailed++;
        if (br === "ok") st.closedBooked++;
        else if (!isRefusal(br)) st.other[br.slice(0, 30)] = (st.other[br.slice(0, 30)] ?? 0) + 1;
        st.competitor[rr === "ok" ? "booked" : rr.slice(0, 20)] = (st.competitor[rr === "ok" ? "booked" : rr.slice(0, 20)] ?? 0) + 1;
        const holders = Number(await one("select count(*) from bookings where court_id = $1 and start_at = $2 and status in ('confirmed', 'pending')", [f.c2, s]));
        if (holders > 1) st.both++;
      }
      console.log(`${fn}, ${lead} first: ${N} races ${JSON.stringify(st)}`);
      rep(`${fn}, ${lead} first, ${N} random races with a rival booking the same slot: no deadlock; every deletion succeeds; the closed account never books; never two live bookings on one slot`,
        st.deadlocks === 0 && st.deletionFailed === 0 && st.closedBooked === 0 && st.both === 0 && Object.keys(st.other).length === 0, st);
    }
    // the closure itself racing the booking (open account, random order), then the deletion
    let cl = { deadlocks: 0, booked: 0, refused: 0, closeFailed: 0, deletionFailed: 0, leftLive: 0, other: {} };
    for (let i = 0; i < N; i++) {
      const f = await person(kind, "open"); const [s, e] = await slot(); closureRaced.push(f.p);
      const [c, b] = [await sess(f.p), await sess(f.p)];
      const first = Math.random() < 0.5;
      const cP = (async () => { if (!first) await sleep(Math.random() * 3); return run(c, "select close_my_account('app')"); })();
      const bP = (async () => { if (first) await sleep(Math.random() * 3); return run(b, BOOK[kind], [CLUB[kind], f.c2, s, e]); })();
      const [cr, br] = await Promise.all([cP, bP]);
      if (deadlock([cr, br])) cl.deadlocks++;
      if (cr !== "ok") cl.closeFailed++;
      if (br === "ok") cl.booked++; else if (isRefusal(br)) cl.refused++; else cl.other[br.slice(0, 30)] = (cl.other[br.slice(0, 30)] ?? 0) + 1;
      const dr = await run(await sess("service"), DELETE, [f.p]);
      if (dr !== "ok") cl.deletionFailed++;
      if ((await live(f.p)) !== 0) cl.leftLive++;
    }
    console.log(`${fn} vs closure: ${N} races ${JSON.stringify(cl)}`);
    rep(`${fn} versus the closure, ${N} random races: no deadlock; each booking either lands before the closure or is refused; the deletion leaves nothing live`,
      cl.deadlocks === 0 && cl.closeFailed === 0 && cl.deletionFailed === 0 && cl.leftLive === 0 && Object.keys(cl.other).length === 0, cl);
  }
}

// ---------------------------------------------------------------- invariants over everything above
if (!CONTROL) {
  const afterClosure = Number(await one(`select count(*) from bookings b join account_deletions d on d.subject_id = b.player_id
    where b.created_at >= d.closing_at and b.player_id::text like 'e8000000-%' and not (b.player_id = any($1::uuid[]))`, [closureRaced]));
  rep("I1 no booking row of any status was created at or after its account's closure", afterClosure === 0, { afterClosure });
  const overlap = Number(await one(`select count(*) from bookings a join bookings b on a.court_id = b.court_id and a.id < b.id
    where a.status in ('confirmed', 'pending') and b.status in ('confirmed', 'pending') and tstzrange(a.start_at, a.end_at) && tstzrange(b.start_at, b.end_at)`));
  rep("I2 no two live bookings overlap on any court", overlap === 0, { overlap });
  const orphanPay = Number(await one("select count(*) from payments p left join bookings b on b.id = p.booking_id where b.id is null"));
  const holdNoPay = Number(await one(`select count(*) from bookings b where b.status = 'pending' and (select count(*) from payments p where p.booking_id = b.id) <> 1`));
  const deskPay = Number(await one(`select count(*) from bookings b join clubs c on c.id = b.club_id join payments p on p.booking_id = b.id where c.payment_mode = 'at_desk'`));
  rep("I3 no partial state: no payment without its booking, every hold has exactly one payment, no payment on a desk booking", orphanPay + holdNoPay + deskPay === 0, { orphanPay, holdNoPay, deskPay });
  const liveClosed = Number(await one(`select count(*) from bookings b join account_deletions d on d.subject_id = b.player_id and d.status in ('data_removed', 'done')
    where b.status in ('confirmed', 'pending')`));
  rep("I4 no live booking remains for any account whose data step ran", liveClosed === 0, { liveClosed });
  const dupTok = Number(await one("select count(*) from (select player_id, client_token from bookings where client_token is not null group by 1, 2 having count(*) > 1) x"));
  rep("I5 no retry token used twice", dupTok === 0, { dupTok });
}
console.log(`RESULT ${oks} ok, ${fails} failed`);
await admin.end();
process.exit(fails ? 1 : 0);
