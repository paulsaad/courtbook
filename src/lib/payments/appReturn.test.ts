// @vitest-environment node
import { describe, it, expect } from "vitest";
import { appReturnLink } from "./appReturn";
import { appReturnUrl } from "./urls";
import { nativePaymentsEnabled } from "./native";

describe("the app's way back from the payment page (M12.4)", () => {
  it("only the two CourtBook app schemes, and the link carries nothing", () => {
    expect(appReturnLink({ PAYMENT_APP_SCHEME: "courtbook" })).toBe("courtbook://payment-return");
    expect(appReturnLink({ PAYMENT_APP_SCHEME: "courtbook-staging" })).toBe("courtbook-staging://payment-return");
    for (const v of [undefined, "", "javascript", "https", "intent", "courtbook://x", "CourtBook", "courtbook-staging2", " courtbook"])
      expect(appReturnLink({ PAYMENT_APP_SCHEME: v })).toBeNull();
  });
  it("the return URL given to the provider carries no attempt, payment or token", () => {
    expect(appReturnUrl("https://courtbook.example")).toBe("https://courtbook.example/pay/app-return");
  });
  it("the deployment switch is on only for exactly NATIVE_PAYMENTS=1", () => {
    expect(nativePaymentsEnabled({ NATIVE_PAYMENTS: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) expect(nativePaymentsEnabled({ NATIVE_PAYMENTS: v })).toBe(false);
  });
});
