import { describe, expect, it, vi } from "vitest";
import {
  blockedRows, blockPlayer, REPORT_NOTE_MAX, REPORT_REASONS, reportMessage, SAFETY_OFFLINE, SAFETY_UNAVAILABLE, SAFETY_UNKNOWN, safetyError, unblockPlayer,
} from "./gameSafety";

const ok = () => vi.fn(async () => ({ data: null, error: null }));
const refuse = (error: unknown) => vi.fn(async () => ({ data: null, error }));

describe("website report and block: same rules as the app", () => {
  it("the reasons are the app's, in the app's order", () => {
    expect(REPORT_REASONS.map((r) => r.label)).toEqual(["Spam", "Abuse or harassment", "Inappropriate", "Threat or danger", "Something else"]);
  });

  it("a report sends only the message id, the reason and a trimmed, capped note", async () => {
    const rpc = ok();
    expect(await reportMessage(rpc, "msg-1", "abuse", `  ${"x".repeat(REPORT_NOTE_MAX + 50)}  `)).toBeNull();
    expect(rpc).toHaveBeenCalledWith("report_content", { p_kind: "message", p_target: "msg-1", p_reason: "abuse", p_note: "x".repeat(REPORT_NOTE_MAX) });
    const rpc2 = ok();
    await reportMessage(rpc2, "msg-1", "spam", "   ");
    expect(rpc2).toHaveBeenCalledWith("report_content", { p_kind: "message", p_target: "msg-1", p_reason: "spam", p_note: null });
  });

  it("block and unblock call the approved functions with the player id only", async () => {
    const rpc = ok();
    await blockPlayer(rpc, "p-2");
    await unblockPlayer(rpc, "p-2");
    expect(rpc.mock.calls).toEqual([["block_player", { p_profile: "p-2" }], ["unblock_player", { p_profile: "p-2" }]]);
  });

  it("server refusals read as sentences about reports and blocks", async () => {
    expect(await reportMessage(refuse({ message: "bad_target" }), "m", "spam", "")).toBe("You can't report or block yourself.");
    expect(await reportMessage(refuse({ message: "not_found" }), "m", "spam", "")).toBe("This message or player isn't available any more.");
    expect(await blockPlayer(refuse({ message: "not_authenticated" }), "p")).toBe("Your session has ended. Sign in again.");
    expect(await blockPlayer(refuse({ code: "PGRST301", message: "JWT expired" }), "p")).toBe("Your session has ended. Sign in again.");
    expect(await reportMessage(refuse({ message: "note_too_long" }), "m", "spam", "")).toBe("Keep the note under 500 characters.");
  });

  it("a network failure, thrown or returned, says so", async () => {
    expect(await blockPlayer(refuse({ message: "TypeError: Failed to fetch" }), "p")).toBe(SAFETY_OFFLINE);
    expect(await reportMessage(vi.fn(async () => { throw new TypeError("Load failed"); }), "m", "spam", "")).toBe(SAFETY_OFFLINE);
  });

  it("before migration 0074 the controls say they are not available yet", () => {
    expect(safetyError({ code: "PGRST202", message: "Could not find the function public.report_content" })).toBe(SAFETY_UNAVAILABLE);
  });

  it("never shows the database's own text", () => {
    const leak = 'duplicate key value violates unique constraint "reports_pkey" DETAIL: Key (reporter_id)=(a1000000-0000-0000-0000-000000000001)';
    expect(safetyError({ message: leak })).toBe(SAFETY_UNKNOWN);
  });

  it("the blocked list keeps only the id and the name", () => {
    const rows = blockedRows([{ profile_id: "p-2", name: "Sami", created_at: "2026-11-20", phone: "+96170000000", email: "s@example.com" }]);
    expect(rows).toEqual([{ profile_id: "p-2", name: "Sami" }]);
    expect(blockedRows(null)).toEqual([]);
  });
});
