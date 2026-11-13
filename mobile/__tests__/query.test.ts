jest.mock("../lib/supabase", () => ({ supabase: { auth: { signOut: jest.fn() } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
import { shouldRetryRead } from "../lib/query";

describe("shouldRetryRead", () => {
  it("retries a network failure twice, then stops", () => {
    const e = new TypeError("Network request failed");
    expect(shouldRetryRead(0, e)).toBe(true);
    expect(shouldRetryRead(1, e)).toBe(true);
    expect(shouldRetryRead(2, e)).toBe(false);
  });

  it("never retries a refusal or a dead session", () => {
    expect(shouldRetryRead(0, { message: "slot_taken" })).toBe(false);
    expect(shouldRetryRead(0, { message: "JWT expired", code: "PGRST301" })).toBe(false);
  });
});
