import { afterEach, describe, expect, it, vi } from "vitest";

/** The staging test page: 404 on production and for anyone but an admin. */
async function render(admin: boolean) {
  vi.resetModules();
  vi.doMock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
  vi.doMock("@/lib/monitoringTest", async () => ({
    ...(await vi.importActual<typeof import("@/lib/monitoringTest")>("@/lib/monitoringTest")),
    isAdmin: async () => admin,
  }));
  return (await import("./page")).default();
}
const STAGING = "https://pwznauyioqykdwodwpvx.supabase.co";
const env = (vercel: string, supabase = STAGING) => { vi.stubEnv("VERCEL_ENV", vercel); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", supabase); };
afterEach(() => { vi.unstubAllEnvs(); });

describe("monitoring test page", () => {
  it("is not found on production, even for an admin", async () => {
    env("production");
    await expect(render(true)).rejects.toThrow("NOT_FOUND");
  });
  it("is not found on a preview connected to the live database, even for an admin", async () => {
    env("preview", "https://lgujfbwunokobjxlvpuf.supabase.co");
    await expect(render(true)).rejects.toThrow("NOT_FOUND");
  });
  it("is not found on staging for anyone but an admin", async () => {
    env("preview");
    await expect(render(false)).rejects.toThrow("NOT_FOUND");
  });
  it("renders for an admin on staging", async () => {
    env("preview");
    expect(await render(true)).toBeTruthy();
  });
});
