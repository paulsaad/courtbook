import { describe, expect, it } from "vitest";
import { AUTH_TEXT, sendCodeError, verifyCodeError } from "./authText";

describe("sign-in code wording (Mission 3A)", () => {
  it("a dropped connection never says the code is wrong", () => {
    expect(verifyCodeError({ name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" })).toBe(AUTH_TEXT.offline);
    expect(verifyCodeError({ message: "Network request failed" })).toBe(AUTH_TEXT.offline);
    expect(sendCodeError({ name: "AuthRetryableFetchError", message: "Load failed" })).toBe(AUTH_TEXT.offline);
  });
  it("a refused or expired code says so", () => {
    expect(verifyCodeError({ name: "AuthApiError", status: 403, code: "otp_expired", message: "Token has expired or is invalid" })).toBe(AUTH_TEXT.wrongCode);
    expect(verifyCodeError({ status: 400, message: "anything" })).toBe(AUTH_TEXT.wrongCode);
  });
  it("rate limits and server faults are named, not blamed on the person", () => {
    expect(sendCodeError({ status: 429, code: "over_email_send_rate_limit", message: "email rate limit exceeded" })).toBe(AUTH_TEXT.rate);
    expect(verifyCodeError({ status: 429, message: "Too many requests" })).toBe(AUTH_TEXT.rate);
    expect(verifyCodeError({ status: 502, message: "Bad gateway" })).toBe(AUTH_TEXT.server);
  });
  it("a malformed email gets its own line; any other send failure is generic, never Supabase's text", () => {
    expect(sendCodeError({ status: 400, code: "email_address_invalid", message: 'Email address "x" is invalid' })).toBe(AUTH_TEXT.badEmail);
    expect(sendCodeError({ status: 422, code: "validation_failed", message: "Unable to validate email address: invalid format" })).toBe(AUTH_TEXT.badEmail);
    const t = sendCodeError({ status: 500, message: "Error sending magic link email" });
    expect(t).toBe(AUTH_TEXT.sendFailed);
    expect(Object.values(AUTH_TEXT)).not.toContain("Error sending magic link email");
  });
  it("a server failure as auth-js 2.119 really names it (AuthRetryableFetchError, 500–530) is not called a lost connection", () => {
    // Auth's answer when the code email cannot be sent (sync sending): 500 "Error sending confirmation email"
    expect(sendCodeError({ name: "AuthRetryableFetchError", status: 500, message: "Error sending confirmation email" })).toBe(AUTH_TEXT.sendFailed);
    expect(sendCodeError({ name: "AuthRetryableFetchError", status: 503, message: "HTTP 503" })).toBe(AUTH_TEXT.sendFailed);
    expect(verifyCodeError({ name: "AuthRetryableFetchError", status: 500, message: "Internal error" })).toBe(AUTH_TEXT.server);
    expect(verifyCodeError({ name: "AuthRetryableFetchError", status: 522, message: "HTTP 522" })).toBe(AUTH_TEXT.server);
    // no answer at all is still offline
    expect(sendCodeError({ name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" })).toBe(AUTH_TEXT.offline);
  });
});
