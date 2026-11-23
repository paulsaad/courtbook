// The real website pipeline (src/lib/deletion/pipeline.ts) against the real 0086 functions, on a disposable copy of
// the replica. Each rpc is one transaction as the service role, as PostgREST runs it. Supabase Auth is simulated on the
// replica's auth.users: ban = a row in e2e_bans; delete = delete from auth.users (the profile goes with it, and
// profiles_delete_guard can refuse it, as in the real system). Failures and kills are injected around these calls.
// Run by pipeline_e2e.sh; never against staging or production.
import { createRequire } from "node:module";
// E2E_PIPELINE: a mutated copy, to prove the checks catch a broken pipeline (pipeline_e2e.sh mutants)
const { processDeletion } = await import(process.env.E2E_PIPELINE ?? "../../../src/lib/deletion/pipeline.ts");

const pg = createRequire(process.env.PG_MODULE + "/")("pg");
const DB = process.env.E2E_DB;
const newClient = async () => { const c = new pg.Client({ host: "/var/run/postgresql", database: DB }); await c.connect(); return c; };
const db = await newClient();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => { const r = await q(sql, args); return r[0] ? Object.values(r[0])[0] : undefined; };

let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { console.log(`ok    ${name}`); oks++; } else { console.log(`FAIL  ${name}  [${detail}]`); fails++; } };

/** One rpc = one transaction as a given role, like PostgREST. Errors come back as {message, code}. */
async function call(client, who, fn, args) {
  const names = Object.keys(args);
  const sql = `select to_jsonb(${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})) as r`;
  try {
    await client.query("begin");
    await client.query(who === "service" ? "set local role service_role" : "set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [who === "service" ? "" : who]);
    // a person signed in just now (0086 review: closing needs a recent sign-in; the token carries the time, "amr")
    await client.query("select set_config('request.jwt.claims', $1, true)", [who === "service" ? "" :
      JSON.stringify({ sub: who, role: "authenticated", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }] })]);
    const r = await client.query(sql, names.map((n) => args[n]));
    await client.query("commit");
    return { data: r.rows[0].r, error: null };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return { data: null, error: { message: e.message, code: e.code } };
  }
}

let inject = {};        // step name → "error" | "kill"
let after = null;       // step name after which the process dies
const hang = () => new Promise(() => {});
/**
 * pause: { at: k } — after this run's k-th call, wait until `release()` (a slow worker, not a dead one: it carries on).
 * `paused` resolves when it has stopped there. log: the calls it made, in order.
 */
function depsFor(client, pause = null) {
  let dead = false, n = 0;
  const log = [];
  let release = () => {};
  const gateOpen = pause ? new Promise((r) => { release = r; }) : null;
  let markPaused = () => {};
  const paused = pause ? new Promise((r) => { markPaused = r; }) : null;
  const gate = async (name, run) => {
    if (dead) return hang();
    if (pause && n >= pause.at) await gateOpen;
    n++;
    log.push(name);
    if (inject[name] === "kill") { dead = true; return hang(); }
    if (inject[name] === "error") return null;
    const out = await run();
    if (after === name) { dead = true; after = null; }
    if (pause && n === pause.at) markPaused();
    return out;
  };
  return {
    log, paused, release: () => release(),
    rpc: async (fn, args) => (await gate(fn, () => call(client, "service", fn, args))) ?? { data: null, error: { message: "injected", code: "XX000" } },
    banUser: async (id) => (await gate("ban", async () => {
      const n = (await client.query("select 1 from auth.users where id = $1", [id])).rowCount;
      if (!n) return { error: { message: "User not found", status: 404 } };
      await client.query("insert into e2e_bans values ($1) on conflict do nothing", [id]);
      return { error: null };
    })) ?? { error: { message: "unavailable", status: 503 } },
    deleteUser: async (id) => (await gate("delete_user", async () => {
      try {
        const n = (await client.query("delete from auth.users where id = $1", [id])).rowCount;
        return n ? { error: null } : { error: { message: "User not found", status: 404 } };
      } catch { return { error: { message: "Database error deleting user", status: 500 } }; }
    })) ?? { error: { message: "unavailable", status: 500 } },
  };
}
const deps = depsFor(db);
const reset = () => { inject = {}; after = null; };

// ---- people and data ------------------------------------------------------------------------------------------
const id = (n) => `e8600000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CLUB = await one("select id from clubs where slug = 'batroun'");
await q("create table if not exists e2e_bans (id uuid primary key)");
await q("update clubs set payment_mode = 'simulated', cancel_cutoff_hours = 6 where id = $1", [CLUB]);
const COURT = id(900);
await q("insert into courts (id, club_id, name, sport, active, sort) values ($1, $2, 'E2E', 'padel', true, 97)", [COURT, CLUB]);
let slot = 0;
async function person(n, name) {
  await q("insert into auth.users (id, phone) values ($1, $2)", [id(n), `+9617860${String(n).padStart(4, "0")}`]);
  await q("update profiles set name = $2, rules_accepted_at = now() where id = $1", [id(n), name]);
}
async function booking(n) {
  const day = 3 + Math.floor(slot / 6), hours = 1 + (slot % 6); slot++;
  const at = `(((current_date + ${day})::timestamp + (select open_time from clubs where id = $1) + interval '${hours} hours') at time zone 'Asia/Beirut')`;
  await q(`insert into bookings (club_id, court_id, player_id, created_by, start_at, end_at, status, source, price_usd, fee_usd)
           values ($1, $2, $3, $3, ${at}, ${at} + interval '60 min', 'confirmed', 'app', 20, 1)`, [CLUB, COURT, id(n)]);
}
async function game(n, other) {
  const g = (await q(`insert into matches (club_id, sport, organizer_id, start_at, end_at, players_needed, status, join_mode)
                      values ($1, 'padel', $2, now() + interval '4 days', now() + interval '4 days 90 min', 3, 'open', 'open') returning id`, [CLUB, id(n)]))[0].id;
  await q("insert into match_players (match_id, profile_id, status) values ($1, $2, 'accepted')", [g, id(other)]);
  return g;
}
// the open record if there is one (a cancelled earlier request can be newer than a backdated one)
const status = (n) => one("select status from account_deletions where subject_id = $1 order by (status not in ('cancelled', 'done')) desc, requested_at desc limit 1", [id(n)]);
const authExists = async (n) => (await one("select count(*)::int from auth.users where id = $1", [id(n)])) === 1;
const banned = async (n) => (await one("select count(*)::int from e2e_bans where id = $1", [id(n)])) === 1;
const notices = (other, g) => one("select count(*)::int from notifications where profile_id = $1 and match_id = $2", [id(other), g]);
const named = (n) => one("select count(*)::int from bookings where player_id = $1", [id(n)]);
const close = (n) => call(db, id(n), "close_my_account", { p_via: "web" });
const expireLease = (n) => q("update account_deletions set lease_until = now() - interval '1 second' where subject_id = $1", [id(n)]);

await person(99, "Other player");

// E1 the whole pipeline
console.log("== E1 close then process: done, everything in order");
await person(1, "Closer one"); await booking(1); await booking(1); const g1 = await game(1, 99);
let c = await close(1);
rep("E1: close answers closing, new", c.data?.status === "closing" && c.data?.new === true, JSON.stringify(c));
let out = await processDeletion(id(1), deps);
rep("E1: done; sign-in banned then deleted; profile gone; nothing under the name", out.result === "done" && await banned(1) && !(await authExists(1))
  && (await one("select count(*)::int from profiles where id = $1", [id(1)])) === 0 && (await named(1)) === 0, JSON.stringify(out));
rep("E1: the other player told once, the game cancelled", (await notices(99, g1)) === 1 && (await one("select status from matches where id = $1", [g1])) === "cancelled");
rep("E1: record done, lease cleared, attempts 1, no error", JSON.stringify(await q("select status, lease_until, attempts, last_error from account_deletions where subject_id = $1", [id(1)]))
  === JSON.stringify([{ status: "done", lease_until: null, attempts: 1, last_error: null }]));
rep("E1: processing again does nothing", (await processDeletion(id(1), deps)).reason === "done");

// E2 each step failing once, then the next run finishing
for (const [k, step] of [[2, "ban"], [3, "delete_account_data"], [4, "delete_user"], [5, "finish_account_deletion"], [6, "record_deletion_step"]]) {
  console.log(`== E2 ${step} fails once`);
  reset(); await person(k, `Closer ${k}`); await booking(k); const g = await game(k, 99);
  await close(k);
  inject[step] = "error";
  out = await processDeletion(id(k), deps);
  const st = await q("select status, last_error, next_attempt_at > now() as later, lease_until is not null as leased from account_deletions where subject_id = $1", [id(k)]);
  rep(`E2 ${step}: failed, recorded with a code (or lease kept if bookkeeping itself failed); not done`, out.result === "failed" && st[0].status !== "done"
    && (step === "record_deletion_step" ? st[0].leased : /^[a-z_]+$/.test(st[0].last_error) && st[0].later && !st[0].leased), JSON.stringify([out, st]));
  rep(`E2 ${step}: the retry list skips it until its backoff has passed`, !(await call(db, "service", "deletions_due", { p_limit: 50 })).data?.includes?.(id(k)), "listed");
  reset();
  if (step === "record_deletion_step") await expireLease(k);
  else await q("update account_deletions set next_attempt_at = now() where subject_id = $1", [id(k)]);
  rep(`E2 ${step}: now due`, JSON.stringify((await call(db, "service", "deletions_due", { p_limit: 50 })).data).includes(id(k)));
  out = await processDeletion(id(k), deps);
  rep(`E2 ${step}: the next run finishes; one notice; sign-in gone`, out.result === "done" && (await notices(99, g)) === 1 && !(await authExists(k)), JSON.stringify(out));
}

// E3 killed after each step: nothing recorded; another run is refused until the lease expires; then it finishes
for (const [k, step] of [[11, "claim_deletion"], [12, "ban"], [13, "record_deletion_step"], [14, "delete_account_data"], [15, "delete_user"]]) {
  console.log(`== E3 the process dies after ${step}`);
  reset(); await person(k, `Closer ${k}`); await booking(k); const g = await game(k, 99);
  await close(k);
  const dying = newClient();
  const dc = await dying;
  after = step;
  void processDeletion(id(k), depsFor(dc));
  for (let i = 0; i < 100 && after; i++) await new Promise((r) => setTimeout(r, 20));
  await dc.end().catch(() => {});
  reset();
  out = await processDeletion(id(k), deps);
  rep(`E3 ${step}: a second run is refused while the dead run's lease lasts`, out.result === "skipped" && out.reason === "leased", JSON.stringify(out));
  await expireLease(k);
  out = await processDeletion(id(k), deps);
  rep(`E3 ${step}: after expiry the next run finishes; one notice; nothing named`, out.result === "done" && (await notices(99, g)) === 1 && (await named(k)) === 0, JSON.stringify(out));
}

// E4 the late booking: a booking lands after the data step (its statement began before the close committed)
console.log("== E4 a booking that lands after the data step is cleaned up by the always-re-run data step");
reset(); await person(21, "Late booker"); await booking(21); await close(21);
inject.delete_user = "error";
await processDeletion(id(21), deps);
rep("E4: after run 1 the data is removed", (await status(21)) === "data_removed");
// the write whose statement began before the close committed (shown possible by races86.sh RC2); stand in for it by
// switching the row guard off for this one insert on the disposable copy
const T = await one("select tgname from pg_trigger t join pg_proc p on p.oid = t.tgfoid where tgrelid = 'bookings'::regclass and proname = 'block_new_activity_after_deletion_request'");
await q(`alter table bookings disable trigger ${T}`); await booking(21); await q(`alter table bookings enable trigger ${T}`);
rep("E4: the late booking is there, under the name", (await named(21)) === 1);
reset(); await q("update account_deletions set next_attempt_at = now() where subject_id = $1", [id(21)]);
out = await processDeletion(id(21), deps);
rep("E4: run 2 re-ran the data step, cancelled it, and finished", out.result === "done" && (await named(21)) === 0
  && (await one("select summary->'last_rerun'->>'bookings_cancelled' from account_deletions where subject_id = $1", [id(21)])) === "1", JSON.stringify(out));

// E5 two runs at once on separate connections
console.log("== E5 two runs at once");
reset(); await person(31, "Double"); await booking(31); const g5 = await game(31, 99); await close(31);
const c2 = await newClient();
const [a, b] = await Promise.all([processDeletion(id(31), deps), processDeletion(id(31), depsFor(c2))]);
await c2.end();
rep("E5: one finished, the other did nothing (busy or leased); one notice", [a, b].filter((o) => o.result === "done").length === 1
  && [a, b].some((o) => o.result === "skipped" && ["busy", "leased"].includes(o.reason)) && (await notices(99, g5)) === 1, JSON.stringify([a, b]));

// E6 held: suspended → banned, cancellations only, name and sign-in kept; release refused while suspended
console.log("== E6 held (suspended), then released");
reset(); await person(41, "Held person"); await booking(41); const g6 = await game(41, 99);
await q("insert into account_suspensions (profile_id, reason) values ($1, 'test')", [id(41)]).catch(async () =>
  q("insert into account_suspensions (profile_id) values ($1)", [id(41)]));
c = await close(41);
rep("E6: closed as held (suspended)", c.data?.status === "held" && c.data?.held_reason === "suspended", JSON.stringify(c));
out = await processDeletion(id(41), deps);
rep("E6: run → held; banned; sign-in and name kept; bookings cancelled; one notice", out.result === "held" && await banned(41) && await authExists(41)
  && (await one("select name from profiles where id = $1", [id(41)])) === "Held person"
  && (await one("select count(*)::int from bookings where player_id = $1 and status = 'confirmed'", [id(41)])) === 0 && (await notices(99, g6)) === 1, JSON.stringify(out));
rep("E6: not picked up again by retries", !JSON.stringify((await call(db, "service", "deletions_due", { p_limit: 50 })).data).includes(id(41)));
rep("E6: release refused while suspended", (await call(db, "service", "release_held_deletion", { p_subject: id(41) })).error?.message === "suspended");
await q("delete from account_suspensions where profile_id = $1", [id(41)]);
rep("E6: release once lifted → closed", (await call(db, "service", "release_held_deletion", { p_subject: id(41) })).data?.status === "closed");
out = await processDeletion(id(41), deps);
rep("E6: the next run finishes; still one notice", out.result === "done" && !(await authExists(41)) && (await notices(99, g6)) === 1, JSON.stringify(out));

// E7 refused at close: staff
console.log("== E7 staff cannot close; nothing written");
await person(51, "Staffer"); await q("insert into club_staff (club_id, profile_id, role) values ($1, $2, 'manager')", [CLUB, id(51)]).catch(async () =>
  q("insert into club_staff (club_id, profile_id) values ($1, $2)", [CLUB, id(51)]));
c = await close(51);
rep("E7: staff_role, no record", c.error?.message === "staff_role" && (await one("select count(*)::int from account_deletions where subject_id = $1", [id(51)])) === 0, JSON.stringify(c));

// E8 the attention list
console.log("== E8 attention and alert marking");
reset(); await person(61, "Stuck"); await close(61);
for (let i = 0; i < 3; i++) { inject.ban = "error"; await processDeletion(id(61), deps); await q("update account_deletions set next_attempt_at = now() where subject_id = $1", [id(61)]); }
let att = (await call(db, "service", "deletions_needing_attention", {})).data;
rep("E8: three failed runs → listed as stuck", JSON.stringify(att).includes(id(61)), JSON.stringify(att));
await call(db, "service", "mark_deletion_alerted", { p_subject: id(61) });
att = (await call(db, "service", "deletions_needing_attention", {})).data;
rep("E8: once alerted, not listed again", !JSON.stringify(att).includes(id(61)));

// E9 (review 23 Nov, finding 5): a SLOW worker A stops after its k-th call; its lease expires; worker B takes over.
// Then A carries on. Whatever A does after that, the end state is the same as one clean run: done, sign-in gone, one
// notice, nothing under the name, no error recorded by A. A must never report "done" for a record B finished.
async function takeover(k, m, label) {
  reset();
  const n0 = 70 + takeover.count++;
  await person(n0, `Takeover ${label}`); await booking(n0); await booking(n0); const g = await game(n0, 99);
  await close(n0);
  const ca = await newClient(), cb = await newClient();
  const A = depsFor(ca, { at: k });
  const runA = processDeletion(id(n0), A);
  // a run with fewer calls than k would never pause: report it instead of waiting for ever
  const reached = (d, run) => Promise.race([d.paused.then(() => true), run.then(() => false)]);
  if (!(await reached(A, runA))) { rep(`E9 ${label}: A reaches call ${k}`, false, JSON.stringify(A.log)); await ca.end(); await cb.end(); return; }
  await expireLease(n0);
  let outB;
  if (m == null) {
    outB = await processDeletion(id(n0), depsFor(cb));
  } else {   // B is slow too: A resumes while B is in the middle
    const B = depsFor(cb, { at: m });
    const runB = processDeletion(id(n0), B);
    if (!(await reached(B, runB))) { rep(`E9 ${label}: B reaches call ${m}`, false, JSON.stringify(B.log)); A.release(); await runA; await ca.end(); await cb.end(); return; }
    A.release();
    const a0 = await runA;
    B.release();
    outB = await runB;
    await ca.end(); await cb.end();
    return check(n0, g, a0, outB, label, A.log);
  }
  A.release();
  const outA = await runA;
  await ca.end(); await cb.end();
  return check(n0, g, outA, outB, label, A.log);
}
takeover.count = 0;
async function check(n0, g, outA, outB, label, logA) {
  const st = await q("select status, last_error, lease_until is null as free from account_deletions where subject_id = $1", [id(n0)]);
  const ok = st[0].status === "done" && st[0].last_error === null && !(await authExists(n0)) && await banned(n0)
    && (await notices(99, g)) === 1 && (await named(n0)) === 0
    && (await one("select count(*)::int from account_deletions where subject_id = $1", [id(n0)])) === 1;
  rep(`E9 ${label}: final state as one clean run (done, sign-in gone, banned, 1 notice, nothing named, no error, 1 record)`, ok,
      JSON.stringify({ st, outA, outB, logA }));
  // A records nothing after the takeover (no error, no second record: checked above) and what it reports is true: it
  // lost the lease, or (paused just before the idempotent finish) the record really is done
  rep(`E9 ${label}: the slow worker stops (lease_lost) or reports only what is true; it records nothing`,
      outA.result === "lease_lost" || (outA.result === "done" && st[0].status === "done") || (outA.result === "failed" && st[0].last_error === null),
      JSON.stringify({ outA, logA }));
  rep(`E9 ${label}: the worker that took over finished it`, outB.result === "done" || outB.result === "lease_lost" || (outB.result === "skipped" && outB.reason === "done"), JSON.stringify(outB));
}
console.log("== E9 a slow worker resumes after its lease expired and another took over");
// A's calls: 1 claim, 2 ban, 3 record banned, 4 renew, 5 data, 6 renew, 7 sign-in delete, 8 renew, 9 finish
for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) await takeover(k, null, `A paused after call ${k}, B runs to the end, then A carries on`);
for (const [k, m] of [[3, 4], [4, 6], [5, 5], [6, 4], [7, 2]]) await takeover(k, m, `A paused after ${k}, B paused after ${m}; A resumes first, then B`);

// E10 (review 23 Nov, finding 3): an older app's request, end to end
console.log("== E10 an older app's request: cancellable for 24 hours, then processed automatically");
reset(); await person(91, "Old app"); await booking(91); const g10 = await game(91, 99);
const req = (n) => call(db, id(n), "request_account_deletion", { p_via: "app" });
let r10 = await req(91);
rep("E10: the older app's request is accepted (requested)", r10.data?.status === "requested", JSON.stringify(r10));
out = await processDeletion(id(91), deps);
rep("E10: not processed during the grace period", out.result === "skipped" && out.reason === "requested" && await authExists(91), JSON.stringify(out));
rep("E10: cancel works during the grace period", !(await call(db, id(91), "cancel_account_deletion", {})).error && (await status(91)) === "cancelled");
r10 = await req(91);
await q("update account_deletions set requested_at = now() - interval '25 hours' where subject_id = $1 and status = 'requested'", [id(91)]);
const p10 = await call(db, "service", "promote_due_requests", {});
rep("E10: after 24 hours the worker promotes it", p10.data === 1 && (await status(91)) === "closing", JSON.stringify(p10));
out = await processDeletion(id(91), deps);
rep("E10: then processes it like any closure (done, sign-in gone, one notice)", out.result === "done" && !(await authExists(91)) && (await notices(99, g10)) === 1, JSON.stringify(out));
rep("E10: the person's earlier cancelled request is kept as history; one open record at a time",
    (await one("select string_agg(status, ',' order by status) from account_deletions where subject_id = $1", [id(91)])) === "cancelled,done");

await db.end();
console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fails === 0 ? 0 : 1);
