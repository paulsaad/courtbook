// Regression tests for clubMode.mjs (finding P1; named so that Jest does not collect it) against a real, throwaway PostgreSQL database whose
// clubs table has the same payment_mode check as staging. Run with e2e/test-staging-cleanup.sh.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordAndSet, restore } from "./clubMode.mjs";

const DB = process.env.CLUBMODE_TEST_DB;
if (!DB) throw new Error("CLUBMODE_TEST_DB missing (use e2e/test-staging-cleanup.sh)");
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-At", "-c", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const CLUB = "16020754-ccbe-4068-aa97-ca7f46ff9f99";
const mode = () => sql(`select payment_mode from clubs where id='${CLUB}'`);
const setMode = (m) => sql(`update clubs set payment_mode='${m}' where id='${CLUB}'`);
let dir;
const file = (n = "mode.json") => path.join(dir, n);

beforeEach(() => {
  sql(`drop table if exists clubs;
       create table clubs (id text primary key, payment_mode text not null default 'simulated',
         constraint clubs_payment_mode_check check (payment_mode in ('simulated','at_desk')));
       insert into clubs values ('${CLUB}', 'simulated');`);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clubmode-"));
});

for (const original of ["simulated", "at_desk"]) {
  test(`normal run from ${original}: at the desk during the run, ${original} afterwards`, () => {
    setMode(original);
    assert.equal(recordAndSet({ sql, club: CLUB, stateFile: file(), runId: "1" }), original);
    assert.equal(mode(), "at_desk");
    assert.deepEqual(restore({ sql, club: CLUB, stateFile: file() }), { restored: true, mode: original });
    assert.equal(mode(), original);
  });
}

test("cancelled before preparation (the P1 incident): clean-up leaves the database untouched", () => {
  for (const current of ["at_desk", "simulated"]) {
    setMode(current);
    const r = restore({ sql, club: CLUB, stateFile: file("never-written.json") });
    assert.equal(r.restored, false);
    assert.match(r.reason, /no record/);
    assert.equal(mode(), current);
  }
});

test("preparation fails reading the mode (club missing): nothing recorded, nothing changed", () => {
  sql(`delete from clubs`);
  sql(`insert into clubs values ('00000000-0000-0000-0000-000000000000', 'at_desk')`);
  assert.throws(() => recordAndSet({ sql, club: CLUB, stateFile: file(), runId: "1" }), /unexpected payment_mode/);
  assert.equal(fs.existsSync(file()), false);
  assert.equal(restore({ sql, club: CLUB, stateFile: file() }).restored, false);
  assert.equal(sql(`select payment_mode from clubs`), "at_desk");
});

test("preparation cannot write its record: throws before changing anything", () => {
  setMode("simulated");
  const unwritable = path.join(dir, "no-such-dir", "mode.json");
  assert.throws(() => recordAndSet({ sql, club: CLUB, stateFile: unwritable, runId: "1" }));
  assert.equal(mode(), "simulated");
  assert.equal(restore({ sql, club: CLUB, stateFile: unwritable }).restored, false);
  assert.equal(mode(), "simulated");
});

test("preparation records, then its update fails: clean-up leaves the original in place", () => {
  setMode("simulated");
  const failingUpdate = (q) => { if (q.startsWith("update")) throw new Error("connection dropped"); return sql(q); };
  assert.throws(() => recordAndSet({ sql: failingUpdate, club: CLUB, stateFile: file(), runId: "1" }), /connection dropped/);
  assert.equal(mode(), "simulated");
  const r = restore({ sql, club: CLUB, stateFile: file() });
  assert.equal(r.restored, false);
  assert.equal(mode(), "simulated");
});

test("changed by something else during the run (e.g. reset_demo): clean-up does not overwrite it", () => {
  setMode("at_desk");
  recordAndSet({ sql, club: CLUB, stateFile: file(), runId: "1" }); // records at_desk
  setMode("simulated"); // someone resets the demo club meanwhile
  const r = restore({ sql, club: CLUB, stateFile: file() });
  assert.equal(r.restored, false);
  assert.match(r.reason, /changed by something else/);
  assert.equal(mode(), "simulated");
});

for (const order of [["A", "B"], ["B", "A"]]) {
  test(`overlapping runs A and B, clean-up order ${order.join(" then ")}: the true original survives`, () => {
    setMode("simulated");
    recordAndSet({ sql, club: CLUB, stateFile: file("A.json"), runId: "A" }); // A records simulated
    recordAndSet({ sql, club: CLUB, stateFile: file("B.json"), runId: "B" }); // B records at_desk (stale)
    for (const run of order) restore({ sql, club: CLUB, stateFile: file(`${run}.json`) });
    assert.equal(mode(), "simulated");
  });
}

test("a corrupt record or one for another club is ignored", () => {
  setMode("at_desk");
  fs.writeFileSync(file(), "{not json");
  assert.equal(restore({ sql, club: CLUB, stateFile: file() }).restored, false);
  fs.writeFileSync(file(), JSON.stringify({ club: "other", original: "simulated", setTo: "at_desk" }));
  assert.equal(restore({ sql, club: CLUB, stateFile: file() }).restored, false);
  fs.writeFileSync(file(), JSON.stringify({ club: CLUB, original: "x'; drop table clubs; --", setTo: "at_desk" }));
  assert.equal(restore({ sql, club: CLUB, stateFile: file() }).restored, false);
  assert.equal(mode(), "at_desk");
});
