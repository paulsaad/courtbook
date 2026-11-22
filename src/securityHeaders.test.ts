import { describe, expect, it } from "vitest";
import nextConfig, { securityHeaders } from "../next.config";

describe("security headers (W1)", () => {
  it("every path gets the frame, content-type, referrer and permissions headers", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([{ source: "/:path*", headers: securityHeaders }]);
    const h = Object.fromEntries(securityHeaders.map((x) => [x.key, x.value]));
    expect(h["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(h["Content-Security-Policy"]).toBe("frame-ancestors 'self'");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=(self)");
  });

  it("the site never asks for camera or microphone (so turning them off breaks nothing)", async () => {
    const { execSync } = await import("node:child_process");
    const hits = execSync("grep -rlE 'getUserMedia|mediaDevices' src --include=*.ts --include=*.tsx || true").toString()
      .split("\n").filter((f) => f && !f.endsWith(".test.ts"));
    expect(hits).toEqual([]);
  });
});
