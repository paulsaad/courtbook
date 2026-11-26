import { describe, expect, it } from "vitest";
import { ACTION_OFFLINE, actionError } from "./actionError";
import { friendlyError } from "./types";

describe("actionError", () => {
  it.each(["TypeError: Failed to fetch", "TypeError: Load failed", "TypeError: NetworkError when attempting to fetch resource.", "Network request failed"])("no connection (%s) → says so", (m) => {
    expect(actionError(m)).toBe(ACTION_OFFLINE);
  });
  it("server reasons keep the shared wording", () => {
    for (const m of ["match_full", "slot_taken", "account_suspended", "some database text", undefined]) expect(actionError(m)).toBe(friendlyError(m));
  });
});
