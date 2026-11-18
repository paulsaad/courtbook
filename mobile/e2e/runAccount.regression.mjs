// Regression tests for runAccount.mjs and the shared concurrency group (18 Nov), on a throwaway
// PostgreSQL database with stand-ins for auth.users, bookings and payments. Run with
// e2e/test-staging-cleanup.sh. Named so that Jest does not collect it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupRunAccount, runEmail } from "./runAccount.mjs";

const DB = process.env.CLUBMODE_TEST_DB;
if (!DB) throw new Error("CLUBMODE_TEST_DB missing (use e2e/test-staging-cleanup.sh)");
const sql = (q) => execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-At", "-c", q], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const count = (q) => Number(sql(q).split("\n")[0]);

function account(email, bookings = 2) {
  const id = sql(`insert into auth.users (email) values ('${email}') returning id`).split("\n")[0];
  for (let i = 0; i < bookings; i++) {
    const b = sql(`insert into bookings (player_id) values ('${id}') returning id`).split("\n")[0];
    sql(`insert into payments (booking_id) values (${b})`);
  }
  return id;
}
const rowsOf = (email) => ({
  user: count(`select count(*) from auth.users where email='${email}'`),
  bookings: count(`select count(*) from bookings b join auth.users u on u.id=b.player_id where u.email='${email}'`),
  payments: count(`select count(*) from payments p join bookings b on b.id=p.booking_id join auth.users u on u.id=b.player_id where u.email='${email}'`),
});

beforeEach(() => {
  sql(`drop schema if exists auth cascade; drop table if exists payments, bookings;
       create schema auth;
       create table auth.users (id uuid primary key default gen_random_uuid(), email text unique not null);
       create table bookings (id serial primary key, player_id uuid not null references auth.users(id));
       create table payments (id serial primary key, booking_id int not null references bookings(id));`);
});

test("clean-up removes only this run's account, bookings and payments", () => {
  const A = runEmail("100", "1"), B = runEmail("200", "1");
  account(A, 2); account(B, 3);
  account("paul.tester@courtbook.test", 1);  // a real tester
  account("e2e-android-99@courtbook.test", 1); // an old-style test address
  assert.equal(cleanupRunAccount({ sql, email: A }), 2);
  assert.deepEqual(rowsOf(A), { user: 0, bookings: 0, payments: 0 });
  assert.deepEqual(rowsOf(B), { user: 1, bookings: 3, payments: 3 });
  assert.deepEqual(rowsOf("paul.tester@courtbook.test"), { user: 1, bookings: 1, payments: 1 });
  assert.deepEqual(rowsOf("e2e-android-99@courtbook.test"), { user: 1, bookings: 1, payments: 1 });
});

test("a re-run attempt has its own account and cleans up only that one", () => {
  const first = runEmail("300", "1"), second = runEmail("300", "2");
  assert.notEqual(first, second);
  account(first, 1); account(second, 1);
  cleanupRunAccount({ sql, email: second });
  assert.equal(rowsOf(first).user, 1);
  assert.equal(rowsOf(second).user, 0);
});

test("cancelled before preparation (no account created): nothing is deleted", () => {
  account(runEmail("400", "1"), 2);
  assert.equal(cleanupRunAccount({ sql, email: runEmail("500", "1") }), 0);
  assert.equal(count(`select count(*) from auth.users`), 1);
  assert.equal(count(`select count(*) from bookings`), 2);
});

test("addresses: only GitHub run ids; clean-up refuses wildcards and anyone else's address", () => {
  assert.equal(runEmail("44378664438", "2"), "e2e-android-44378664438-2@courtbook.test");
  for (const bad of ["%", "1' or '1'='1", "1;drop", "", "12a"]) assert.throws(() => runEmail(bad, "1"));
  assert.throws(() => runEmail("1", "x"));
  account("paul.tester@courtbook.test", 1);
  for (const e of ["e2e-android-%@courtbook.test", "e2e-android-1-1@courtbook.test' or ''='", "paul.tester@courtbook.test", "e2e-android-99@courtbook.test"]) {
    assert.throws(() => cleanupRunAccount({ sql, email: e }), /refusing/);
  }
  assert.equal(count(`select count(*) from auth.users`), 1);
});

test("every workflow that changes shared staging data is in the one concurrency group", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.github/workflows");
  const markers = /staging\.mjs|staging-tester\.mjs|staging_smoke\.sh|staging_api\.mjs|payment_mode/;
  const writers = fs.readdirSync(dir).filter((f) => f.endsWith(".yml") && markers.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(writers.sort(), ["mobile-android-e2e.yml", "staging-db.yml"]);
  for (const f of writers) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.match(text, /^concurrency:\n {2}group: staging-shared-data\n {2}cancel-in-progress: false$/m, `${f} must use the shared group`);
    assert.doesNotMatch(text.replace(/^concurrency:[\s\S]*?\n(?=\S)/m, ""), /^\s+concurrency:/m, `${f}: no job-level group overriding it`);
  }
});
