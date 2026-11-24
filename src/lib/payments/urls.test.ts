import { describe, expect, it } from "vitest";
import { attemptReturnUrl, isSafeRedirect, isUuid, paymentSiteOrigin, providerCallbackUrl } from "./urls";

/** M12.1 review: provider URLs come from configuration only, never from the incoming request. */
describe("payment site origin (PAYMENT_SITE_URL)", () => {
  it.each([
    ["https://courtbook.example", "https://courtbook.example"],
    ["https://courtbook.example/", "https://courtbook.example"],
    ["  https://courtbook.example  ", "https://courtbook.example"],
    ["http://localhost:3000", "http://localhost:3000"],
  ])("accepts %s", (raw, want) => expect(paymentSiteOrigin({ PAYMENT_SITE_URL: raw })).toBe(want));
  it.each([
    [undefined], [""], ["courtbook.example"], ["http://courtbook.example"], ["https://courtbook.example/app"],
    ["https://courtbook.example?x=1"], ["https://courtbook.example#x"], ["https://user:pw@courtbook.example"], ["javascript:alert(1)"], ["ftp://courtbook.example"],
  ])("refuses %s", (raw) => expect(paymentSiteOrigin({ PAYMENT_SITE_URL: raw })).toBeNull());
});

describe("URLs given to a provider", () => {
  const A = "0a000000-0000-4000-8000-000000000001";
  it("return URL names only the attempt", () => expect(attemptReturnUrl("https://courtbook.example", A)).toBe(`https://courtbook.example/pay/return?attempt=${A}`));
  it("refuses anything but an attempt id in the return URL", () => expect(() => attemptReturnUrl("https://x.example", "../../evil")).toThrow());
  it("callback URL names only a provider", () => {
    expect(providerCallbackUrl("https://courtbook.example", "whish")).toBe("https://courtbook.example/api/pay/callback/whish");
    expect(() => providerCallbackUrl("https://courtbook.example", "whish/../x")).toThrow();
  });
  it("a player is sent only to an https payment page", () => {
    expect(isSafeRedirect("https://pay.example/session/1")).toBe(true);
    for (const u of ["http://pay.example", "javascript:alert(1)", "https://u:p@pay.example", "not a url"]) expect(isSafeRedirect(u)).toBe(false);
  });
  it("ids are checked as UUIDs", () => {
    expect(isUuid(A)).toBe(true);
    for (const v of ["", "x", 1, null, `${A}x`, A.slice(1)]) expect(isUuid(v)).toBe(false);
  });
});
