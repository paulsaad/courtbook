import { afterEach, describe, expect, it, vi } from "vitest";

/** The deliberate-error route: 404 on production and for anyone but an admin; otherwise it throws. */
async function load(admin: boolean) {
  vi.resetModules();
  vi.doMock("@/lib/monitoringTest", async () => ({
    ...(await vi.importActual<typeof import("@/lib/monitoringTest")>("@/lib/monitoringTest")),
    isAdmin: async () => admin,
  }));
  return (await import("./route")).GET;
}
const req = (kind: string) => new Request(`https://x.test/api/monitoring/test?kind=${kind}`);
const STAGING = "https://pwznauyioqykdwodwpvx.supabase.co";
const LIVE = "https://lgujfbwunokobjxlvpuf.supabase.co";
const env = (vercel: string, supabase = STAGING) => { vi.stubEnv("VERCEL_ENV", vercel); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", supabase); };
afterEach(() => { vi.unstubAllEnvs(); });

describe("monitoring test route", () => {
  it("does not exist on production, even for an admin", async () => {
    env("production");
    const GET = await load(true);
    expect((await GET(req("server"))).status).toBe(404);
    expect((await GET(req("probe"))).status).toBe(404);
  });
  it("does not exist outside an approved environment, even for an admin", async () => {
    for (const [vercel, supabase] of [["preview", LIVE], ["development", STAGING], ["", STAGING], ["preview", ""]]) {
      env(vercel, supabase);
      const GET = await load(true);
      expect((await GET(req("server"))).status).toBe(404);
    }
  });
  it("does not exist on staging for anyone but an admin", async () => {
    env("preview");
    const GET = await load(false);
    expect((await GET(req("server"))).status).toBe(404);
  });
  it("throws the fixed test error or the privacy probe for an admin on staging", async () => {
    env("preview");
    const GET = await load(true);
    await expect(GET(req("server"))).rejects.toThrow("CourtBook monitoring test (server)");
    await expect(GET(req("probe"))).rejects.toThrow(/^privacy probe:/);
  });
});
