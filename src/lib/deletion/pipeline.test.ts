// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { processDeletion, dbCode, type DeletionDeps, type RpcResult } from "./pipeline";

/**
 * A small model of 0086's server functions (claim lease + token, record_deletion_step, the data step, finish) and of
 * Supabase Auth (ban, delete). The real functions are tested on the database replica (supabase/tests/m86); here the
 * point is the pipeline's order and its behaviour when any step fails or a run is interrupted and resumed.
 */
const S = "d8600000-0000-4000-8000-0000000000aa";
type Rec = { status: string; held_reason: string | null; banned: boolean; cancellations: boolean; lease: string | null;
  attempts: number; last_error: string | null; dataRuns: number; noticesSent: number; cancelRuns: number };

let rec: Rec;
let authUser: { exists: boolean; banned: boolean };
let profileExists: boolean;
let fail: Partial<Record<string, "error" | "throw">>;
let calls: string[];
let afterStep: ((name: string) => void) | null;
/** The process died: every later call never answers (and so nothing is recorded). */
let killed = false;
const hang = () => new Promise<never>(() => {});

function reset(status = "closing", held_reason: string | null = null) {
  rec = { status, held_reason, banned: false, cancellations: false, lease: null, attempts: 0, last_error: null, dataRuns: 0, noticesSent: 0, cancelRuns: 0 };
  authUser = { exists: true, banned: false };
  profileExists = true;
  fail = {};
  calls = [];
  afterStep = null;
  killed = false;
}
const err = (message: string): RpcResult => ({ data: null, error: { message, code: "P0001" } });
const ok = (data: unknown = null): RpcResult => ({ data, error: null });

function guard(name: string) {
  calls.push(name);
  if (killed) return "killed";
  if (fail[name] === "throw") throw new TypeError("fetch failed");
  return fail[name] === "error";
}

const deps: DeletionDeps = {
  async rpc(fn, a) {
    const g = guard(fn);
    if (g === "killed") return hang();
    if (g) return err(fn === "delete_account_data" ? "staff_role" : "boom: something with text");
    let out: RpcResult;
    switch (fn) {
      case "claim_deletion": {
        if (["done", "cancelled"].includes(rec.status)) { out = ok({ claimed: false, reason: rec.status }); break; }
        if (rec.lease) { out = ok({ claimed: false, reason: "leased" }); break; }
        if (rec.status === "held" && rec.banned && rec.cancellations) { out = ok({ claimed: false, reason: "held" }); break; }
        rec.lease = `t${++rec.attempts}`;
        out = ok({ claimed: true, token: rec.lease, status: rec.status, held_reason: rec.held_reason, banned: rec.banned, cancellations_done: rec.cancellations, attempts: rec.attempts });
        break;
      }
      case "record_deletion_step": {
        if (a.p_token !== rec.lease) { out = err("lease_lost"); break; }
        if (a.p_step === "banned") { rec.banned = true; if (rec.status === "closing") rec.status = "closed"; }
        else if (a.p_step === "failed") { rec.last_error = a.p_error as string; rec.lease = null; }
        else if (a.p_step === "released") { rec.lease = null; rec.last_error = null; }
        else if (a.p_step === "renew") { /* token checked above; the lease is extended */ }
        out = ok({ status: rec.status });
        break;
      }
      case "delete_account_data": {
        if (a.p_cancel_only) {
          if (rec.status !== "held") { out = err("not_held"); break; }
          rec.cancelRuns++; if (!rec.cancellations) { rec.noticesSent++; rec.cancellations = true; }
          out = ok({}); break;
        }
        if (rec.status === "held") { out = err(`held: ${rec.held_reason}`); break; }
        rec.dataRuns++;
        if (rec.status !== "data_removed") { rec.noticesSent++; rec.status = "data_removed"; }   // all-or-nothing, at most once
        out = ok({}); break;
      }
      case "finish_account_deletion": {
        if (profileExists) { out = err("account_still_exists"); break; }
        if (rec.status === "done") { out = ok(); break; }
        if (rec.status !== "data_removed") { out = err("no_removed_request"); break; }
        rec.status = "done"; rec.lease = null; out = ok(); break;
      }
      default: throw new Error(`unexpected rpc ${fn}`);
    }
    afterStep?.(fn);
    return out;
  },
  async banUser() {
    const g = guard("ban");
    if (g === "killed") return hang();
    if (g) return { error: { message: "Service unavailable", status: 503 } };
    if (!authUser.exists) return { error: { message: "User not found", status: 404 } };
    authUser.banned = true; afterStep?.("ban"); return { error: null };
  },
  async deleteUser() {
    const g = guard("delete_user");
    if (g === "killed") return hang();
    if (g) return { error: { message: "Database error deleting user", status: 500 } };
    if (!authUser.exists) return { error: { message: "User not found", status: 404 } };
    if (rec.status !== "data_removed") return { error: { message: "Database error deleting user", status: 500 } };   // profiles_delete_guard
    authUser.exists = false; profileExists = false; afterStep?.("delete_user"); return { error: null };
  },
};
const realBan = deps.banUser;
/** The lease expiring (5 min) — what lets a later run continue after one that died without recording anything. */
const expireLease = () => { rec.lease = null; };

beforeEach(() => reset());

describe("happy path", () => {
  it("closing → banned → data → sign-in deleted → done, in that order", async () => {
    expect(await processDeletion(S, deps)).toEqual({ result: "done" });
    expect(calls).toEqual(["claim_deletion", "ban", "record_deletion_step", "record_deletion_step", "delete_account_data", "record_deletion_step", "delete_user", "record_deletion_step", "finish_account_deletion"]);
    expect(rec).toMatchObject({ status: "done", banned: true, lease: null, noticesSent: 1 });
    expect(authUser.exists).toBe(false);
  });
  it("a finished record is not processed again", async () => {
    await processDeletion(S, deps); calls = [];
    expect(await processDeletion(S, deps)).toEqual({ result: "skipped", reason: "done" });
    expect(calls).toEqual(["claim_deletion"]);
  });
  it("a subject that is not a uuid does nothing", async () => {
    expect(await processDeletion("x' or 1=1", deps)).toEqual({ result: "skipped", reason: "none" });
    expect(calls).toEqual([]);
  });
});

describe("a failure at each step is recorded, and the next run continues from there", () => {
  const steps: Array<[string, string, string]> = [
    ["ban", "ban", "ban_failed"],
    ["record_deletion_step", "record", "failed"],
    ["delete_account_data", "data", "data_staff_role"],
    ["delete_user", "auth_delete", "auth_delete_failed"],
    ["finish_account_deletion", "finish", "finish_failed"],
  ];
  for (const [name, step, code] of steps) {
    it(`${name} fails → recorded as ${code}; a second run finishes; one notice, one data change`, async () => {
      fail[name] = "error";
      const first = await processDeletion(S, deps);
      expect(first).toMatchObject({ result: "failed", step });
      if (name === "record_deletion_step") {
        expect(rec.lease).not.toBeNull();          // bookkeeping itself failed: the lease holds until it expires
        expireLease();
      } else {
        expect(rec.last_error).toBe(code);
        expect(rec.lease).toBeNull();
      }
      expect(rec.status).not.toBe("done");
      fail = {};
      expect(await processDeletion(S, deps)).toEqual({ result: "done" });
      expect(rec.noticesSent).toBe(1);
      expect(authUser.exists).toBe(false);
    });
  }
  it("a database message that is not a bare code is recorded as a generic code, never as text", async () => {
    fail.finish_account_deletion = "error";
    await processDeletion(S, deps);
    expect(rec.last_error).toBe("finish_failed");
  });
  it("a thrown network error is recorded ('record_exception') and the next run finishes", async () => {
    fail.delete_user = "throw";
    expect(await processDeletion(S, deps)).toMatchObject({ result: "failed", code: "exception" });
    expect(rec.last_error).toBe("record_exception");
    fail = {};
    expect(await processDeletion(S, deps)).toEqual({ result: "done" });
  });
});

describe("interrupted after each step (the run dies, nothing recorded), then resumed after the lease expires", () => {
  for (const after of ["ban", "record_deletion_step", "delete_account_data", "delete_user", "finish_account_deletion"]) {
    it(`dies after ${after} → nothing recorded; after the lease expires the next run reaches done, once`, async () => {
      afterStep = (n) => { if (n === after) { afterStep = null; killed = true; } };
      void processDeletion(S, deps);                     // never settles: the process is gone
      await new Promise((r) => setTimeout(r, 0));
      expect(killed).toBe(true);
      expect(rec.last_error).toBeNull();
      killed = false;
      if (rec.status !== "done") {
        calls = [];
        expect(await processDeletion(S, deps)).toEqual({ result: "skipped", reason: "leased" });   // not before expiry
        expireLease();
      }
      const second = await processDeletion(S, deps);
      expect(second.result === "done" || (second.result === "skipped" && second.reason === "done")).toBe(true);
      expect(rec).toMatchObject({ status: "done", banned: true, noticesSent: 1 });
      expect(authUser.exists).toBe(false);
    });
  }
  it("the data step is re-run even when an earlier run completed it (the late-booking race)", async () => {
    fail.delete_user = "error";
    await processDeletion(S, deps);
    expect(rec.dataRuns).toBe(1);
    fail = {};
    await processDeletion(S, deps);
    expect(rec.dataRuns).toBe(2);
    expect(calls.lastIndexOf("delete_account_data")).toBeLessThan(calls.lastIndexOf("delete_user"));
    expect(rec.noticesSent).toBe(1);
  });
  it("the sign-in is never deleted before the data step: an earlier data failure stops the run before D", async () => {
    fail.delete_account_data = "error";
    await processDeletion(S, deps);
    expect(calls).not.toContain("delete_user");
    expect(authUser.exists).toBe(true);
  });
});

describe("overlapping runs and lost leases", () => {
  it("a second run while the first holds the lease does nothing", async () => {
    let second: unknown;
    afterStep = (n) => { if (n === "ban") { afterStep = null; second = processDeletion(S, deps); } };
    expect(await processDeletion(S, deps)).toEqual({ result: "done" });
    expect(await second).toEqual({ result: "skipped", reason: "leased" });
    expect(rec.noticesSent).toBe(1);
  });
  it("a run whose lease was taken over stops at its next bookkeeping and records nothing", async () => {
    afterStep = (n) => { if (n === "ban") { afterStep = null; rec.lease = "someone-else"; } };
    expect(await processDeletion(S, deps)).toEqual({ result: "lease_lost", step: "ban" });
    expect(rec.last_error).toBeNull();
  });
  it("taken over after the data step: stops at its renewal, before deleting the sign-in; the record is the new run's", async () => {
    afterStep = (n) => { if (n === "delete_account_data") { afterStep = null; rec.lease = "someone-else"; } };
    expect(await processDeletion(S, deps)).toEqual({ result: "lease_lost", step: "auth_delete" });
    expect(calls).not.toContain("delete_user");
    expect(rec.last_error).toBeNull();
    expect(rec.lease).toBe("someone-else");
  });
  it("a run that loses its lease and then fails does not overwrite the other run's record", async () => {
    fail.delete_user = "error";
    afterStep = (n) => { if (n === "delete_account_data") { afterStep = null; rec.lease = "someone-else"; } };
    expect(await processDeletion(S, deps)).toEqual({ result: "lease_lost", step: "auth_delete" });
    expect(rec.last_error).toBeNull();
    expect(rec.lease).toBe("someone-else");
  });
  it("a claim error stops before anything else", async () => {
    fail.claim_deletion = "error";
    expect(await processDeletion(S, deps)).toEqual({ result: "failed", step: "claim", code: "failed" });
    expect(calls).toEqual(["claim_deletion"]);
  });
});

describe("held accounts (legal hold, coach bookings, suspended)", () => {
  beforeEach(() => reset("held", "legal_hold"));
  it("banned, cancellations only, then released; nothing else deleted, sign-in kept", async () => {
    expect(await processDeletion(S, deps)).toEqual({ result: "held", reason: "legal_hold" });
    expect(calls).toEqual(["claim_deletion", "ban", "record_deletion_step", "record_deletion_step", "delete_account_data", "record_deletion_step"]);
    expect(rec).toMatchObject({ status: "held", banned: true, cancellations: true, lease: null, dataRuns: 0 });
    expect(authUser).toEqual({ exists: true, banned: true });
  });
  it("once banned and cancelled, a held record is not claimed again", async () => {
    await processDeletion(S, deps); calls = [];
    expect(await processDeletion(S, deps)).toEqual({ result: "skipped", reason: "held" });
    expect(calls).toEqual(["claim_deletion"]);
  });
  it("a failed cancel-only step is retried, and the cancellations happen once", async () => {
    fail.delete_account_data = "error";
    expect(await processDeletion(S, deps)).toMatchObject({ result: "failed", step: "cancel_only" });
    fail = {};
    expect(await processDeletion(S, deps)).toMatchObject({ result: "held" });
    expect(rec.noticesSent).toBe(1);
  });
  it("after an admin release (status closed, banned) the next run completes C → E without banning again", async () => {
    await processDeletion(S, deps);
    rec.status = "closed"; rec.held_reason = null; calls = [];
    expect(await processDeletion(S, deps)).toEqual({ result: "done" });
    expect(calls).not.toContain("ban");
  });
});

describe("sign-in already gone", () => {
  it("ban 'not found' and delete 'not found' are treated as done", async () => {
    authUser.exists = false;
    // profile gone too would make C fail in reality; here we only check the auth answers are accepted
    rec.status = "data_removed"; rec.banned = false; profileExists = false;
    expect(await processDeletion(S, deps)).toEqual({ result: "done" });
  });
});

describe("only Supabase Auth's own 'user not found' counts as already done", () => {
  it("a 404 from somewhere else (wrong URL, proxy) is a failure, not a ban", async () => {
    deps.banUser = (async () => { calls.push("ban"); return { error: { message: "Not Found", status: 404 } }; }) as DeletionDeps["banUser"];
    try {
      expect(await processDeletion(S, deps)).toMatchObject({ result: "failed", step: "ban" });
      expect(rec.banned).toBe(false);
    } finally { deps.banUser = realBan; }
  });
  it("404 with code user_not_found is accepted", async () => {
    deps.banUser = (async () => ({ error: { message: "whatever", status: 404, code: "user_not_found" } })) as DeletionDeps["banUser"];
    try { expect(await processDeletion(S, deps)).toEqual({ result: "done" }); } finally { deps.banUser = realBan; }
  });
  it("a non-404 saying 'not found' is a failure", async () => {
    deps.banUser = (async () => ({ error: { message: "User not found", status: 500 } })) as DeletionDeps["banUser"];
    try { expect(await processDeletion(S, deps)).toMatchObject({ result: "failed", step: "ban" }); } finally { deps.banUser = realBan; }
  });
});

describe("dbCode", () => {
  it("keeps bare codes, maps held, refuses text", () => {
    expect(dbCode({ message: "staff_role" })).toBe("staff_role");
    expect(dbCode({ message: "held: legal_hold" })).toBe("held_legal_hold");
    expect(dbCode({ message: "Jana Probe +961 70 123 456" })).toBe("failed");
    expect(dbCode({ message: "duplicate key value violates unique constraint" })).toBe("failed");
    expect(dbCode(null)).toBe("failed");
  });
});
