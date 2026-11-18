import { OFFLINE_RESERVE_LABEL, reserveButton, type ReserveButtonInput } from "../lib/reserveButton";

/** The rule exactly as it was on the club screen at cec5a95, before the offline case. */
function before(i: ReserveButtonInput) {
  const label =
    i.phase === "sending" ? "Reserving…"
    : i.phase === "checking" ? "Checking…"
    : i.phase === "uncertain" ? "Check now"
    : !i.signedIn ? "Sign in to reserve"
    : i.blocked ? "Earlier booking not confirmed"
    : i.modePending ? "Checking the club…"
    : !i.atDesk ? "Reserve on the website for now"
    : "Reserve court";
  return { label, disabled: i.phase === "idle" && i.signedIn && (i.blocked || !i.atDesk || !i.priceKnown) };
}

const phases = ["idle", "sending", "checking", "uncertain"] as const;
const bools = [true, false];
function* all(online: boolean): Generator<ReserveButtonInput> {
  for (const phase of phases) for (const signedIn of bools) for (const blocked of bools)
    for (const modePending of bools) for (const atDesk of bools) for (const priceKnown of bools)
      yield { phase, signedIn, online, blocked, modePending, atDesk, priceKnown };
}

const ready: ReserveButtonInput = { phase: "idle", signedIn: true, online: true, blocked: false, modePending: false, atDesk: true, priceKnown: true };

it("online: identical to the previous rule in every combination", () => {
  let n = 0;
  for (const i of all(true)) { expect(reserveButton(i)).toEqual(before(i)); n++; }
  expect(n).toBe(128);
});

it("offline and ready to reserve: disabled, and says why", () => {
  expect(reserveButton(ready)).toEqual({ label: "Reserve court", disabled: false });
  expect(reserveButton({ ...ready, online: false })).toEqual({ label: OFFLINE_RESERVE_LABEL, disabled: true });
  expect(OFFLINE_RESERVE_LABEL).toBe("Connect to the internet to reserve");
});

it("offline: never pressable while idle, signed in or not", () => {
  for (const i of all(false)) if (i.phase === "idle") expect(reserveButton(i).disabled).toBe(true);
});

it("offline signed out: asks for the connection, not a sign-in that cannot work", () => {
  expect(reserveButton({ ...ready, online: false, signedIn: false }).label).toBe(OFFLINE_RESERVE_LABEL);
});

it("offline with an unresolved earlier booking: keeps that wording (phone test P2), disabled", () => {
  expect(reserveButton({ ...ready, online: false, blocked: true })).toEqual({ label: "Earlier booking not confirmed", disabled: true });
});

it("offline mid-request or unresolved here: unchanged (busy states and Check now are not this fix)", () => {
  for (const phase of ["sending", "checking", "uncertain"] as const) {
    const i = { ...ready, phase, online: false };
    expect(reserveButton(i)).toEqual(before(i));
  }
});
