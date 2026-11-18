// The one staging account an emulator/simulator test run creates, and the clean-up of exactly that
// account (18 Nov). Clean-up used to delete every e2e-android-%@courtbook.test account with its bookings
// and payments, which could remove another run's account mid-test. Now each run (and each re-run attempt)
// has its own address, derived from GitHub's run id and attempt, and clean-up deletes only rows tied to
// that exact address. It needs no record from preparation, so it is also safe after a cancelled run.

/** The run's own address. Only digits from GitHub (or "local") are accepted, so it is safe in SQL. */
export function runEmail(runId, attempt = "1") {
  if (!/^(\d{1,20}|local)$/.test(String(runId)) || !/^\d{1,3}$/.test(String(attempt))) {
    throw new Error(`unexpected run id/attempt: ${JSON.stringify([runId, attempt])}`);
  }
  return `e2e-android-${runId}-${attempt}@courtbook.test`;
}

/** Delete this run's payments, bookings and account; nothing else. Returns how many bookings it removed. */
export function cleanupRunAccount({ sql, email }) {
  if (!/^e2e-android-(\d{1,20}|local)-\d{1,3}@courtbook\.test$/.test(email)) throw new Error(`refusing to clean up ${JSON.stringify(email)}`);
  const mine = `(select id from auth.users where email = '${email}')`;
  const left = sql(`select count(*) from bookings where player_id in ${mine}`).split("\n")[0].trim();
  sql(`delete from payments where booking_id in (select id from bookings where player_id in ${mine});
       delete from bookings where player_id in ${mine};
       delete from auth.users where email = '${email}';`);
  return Number(left);
}
