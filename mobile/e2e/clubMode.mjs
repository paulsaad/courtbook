// The demo club's payment mode during an emulator/simulator test run (finding P1, 18 Nov).
//
// The run needs the club "at the desk" and must hand back whatever it found. What went wrong: a run
// cancelled before preparing still ran its clean-up, found no record of the original mode and wrote
// a hard-coded default over the real value. The rules now:
//   1. The original value is recorded (to a file) BEFORE anything is changed; if it cannot be recorded,
//      nothing is changed.
//   2. Clean-up restores only a value it recorded. No record (cancelled before preparing, preparation
//      failed before recording, unreadable record) → the database is left untouched.
//   3. Clean-up restores only if the mode is still what the run set (compare-and-swap). If anything else
//      changed it meanwhile — another workflow, a person, an overlapping run — it is left as it is.
import fs from "node:fs";

export const MODES = ["simulated", "at_desk"]; // clubs_payment_mode_check
export const TEST_MODE = "at_desk";
const valid = (m) => typeof m === "string" && MODES.includes(m);

/** Record the original mode, then set the test mode. Throws (having changed nothing) if it cannot record. */
export function recordAndSet({ sql, club, stateFile, runId }) {
  if (!/^[0-9a-f-]{36}$/.test(club)) throw new Error(`club id looks wrong: ${JSON.stringify(club)}`);
  const original = sql(`select payment_mode from clubs where id='${club}'`);
  if (!valid(original)) throw new Error(`unexpected payment_mode ${JSON.stringify(original)}; nothing changed`);
  fs.writeFileSync(stateFile, JSON.stringify({ club, original, setTo: TEST_MODE, runId }));
  sql(`update clubs set payment_mode='${TEST_MODE}' where id='${club}'`);
  return original;
}

/** Restore the recorded original, only if one was recorded and the mode is still the test mode. */
export function restore({ sql, club, stateFile }) {
  let st;
  try {
    st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { restored: false, reason: "no record of the original mode (preparation did not record it); database left untouched" };
  }
  if (!st || st.club !== club || !valid(st.original) || st.setTo !== TEST_MODE) {
    return { restored: false, reason: "record unreadable or for another club; database left untouched" };
  }
  // psql prints the returned row, then the command tag ("UPDATE 1"); only the row matters.
  const out = sql(`update clubs set payment_mode='${st.original}' where id='${club}' and payment_mode='${st.setTo}' returning payment_mode`);
  return out.split("\n")[0].trim() === st.original
    ? { restored: true, mode: st.original }
    : { restored: false, reason: `mode changed by something else since preparation; left as it is (recorded ${st.original})` };
}
