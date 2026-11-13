import { classify } from "../lib/errors";
import { ERRORS } from "@shared/types";

describe("classify", () => {
  it("uses the web app's own sentence for a database reason", () => {
    const f = classify({ message: "slot_taken", code: "P0001" });
    expect(f).toEqual({ kind: "refused", reason: "slot_taken", message: ERRORS.slot_taken });
  });

  it("prefers the longer reason when one contains another", () => {
    expect(classify({ message: "court_not_found" }).reason).toBe("court_not_found");
    expect(classify({ message: "booking_not_found" }).reason).toBe("booking_not_found");
  });

  it.each([
    [{ message: "not_authenticated" }],
    [{ message: "JWT expired", code: "PGRST301" }],
    [{ message: "whatever", status: 401 }],
    [{ message: "Invalid Refresh Token", code: "refresh_token_not_found" }],
  ])("treats %j as a session failure", (e) => {
    expect(classify(e).kind).toBe("auth");
  });

  it.each([
    [new TypeError("Network request failed")],
    [{ message: "Failed to fetch" }],
    [{ name: "AbortError", message: "The operation was aborted." }],
  ])("treats %j as a network failure, never as a refusal", (e) => {
    expect(classify(e).kind).toBe("network");
  });

  it("does not leak raw text for something it does not recognise", () => {
    const f = classify({ message: 'duplicate key value violates unique constraint "x"' });
    expect(f.kind).toBe("unknown");
    expect(f.message).not.toMatch(/duplicate key/);
  });
});
