import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
const { STAGING_SUPABASE_HOST, testErrorsAllowed } = await import("./monitoringTest");

const STAGING = `https://${STAGING_SUPABASE_HOST}`;

describe("testErrorsAllowed: explicit allowlist (review correction 3)", () => {
  it("allows a Vercel Preview deployment connected to the staging database", () => {
    expect(testErrorsAllowed("preview", STAGING)).toBe(true);
    expect(testErrorsAllowed("preview", `${STAGING}/`)).toBe(true);
  });
  it("refuses production, local, unknown and missing environments", () => {
    for (const env of ["production", "development", "test", "Preview", "", undefined]) expect(testErrorsAllowed(env, STAGING)).toBe(false);
  });
  it("refuses a preview connected to any other database, or to none", () => {
    for (const url of ["https://lgujfbwunokobjxlvpuf.supabase.co", `http://${STAGING_SUPABASE_HOST}`,
      `https://${STAGING_SUPABASE_HOST}.evil.example`, "not a url", "", undefined])
      expect(testErrorsAllowed("preview", url)).toBe(false);
  });
});
