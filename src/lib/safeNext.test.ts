// @vitest-environment node
import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safeNext";

describe("safeNextPath: after sign-in, only a path on this site", () => {
  it("keeps ordinary paths, with their query and fragment", () => {
    for (const p of ["/", "/profile", "/club/batroun?date=2026-12-01", "/bookings/6f1c2a8e-1111-4111-8111-111111111111", "/me#upcoming", "/pay/x?attempt=1"]) {
      expect(safeNextPath(p)).toBe(p);
    }
  });
  it("refuses every form that a browser would send to another site (open redirect)", () => {
    const attacks = ["//evil.example", "/\\evil.example", "/\\/evil.example", "\\\\evil.example", "/\t/evil.example", "/\n/evil.example", "/\r//evil.example",
      "https://evil.example", "http://evil.example/x", "javascript:alert(1)", "evil.example", " /x", "/x y", "", "/".repeat(3000)];
    for (const a of attacks) {
      expect(safeNextPath(a)).toBe("/");
      // and whatever is returned stays on our origin
      expect(new URL(safeNextPath(a), "https://courtbook.example").host).toBe("courtbook.example");
    }
  });
  it("the old check let these through — the reason for this function", () => {
    const old = (n: string) => n.startsWith("/") && !n.startsWith("//");
    for (const a of ["/\\evil.example", "/\t/evil.example"]) {
      expect(old(a)).toBe(true);
      expect(new URL(a, "https://courtbook.example").host).toBe("evil.example");
      expect(safeNextPath(a)).toBe("/");
    }
  });
  it("non-strings are refused", () => {
    for (const x of [undefined, null, 1, {}, ["/x"]]) expect(safeNextPath(x)).toBe("/");
  });
});
