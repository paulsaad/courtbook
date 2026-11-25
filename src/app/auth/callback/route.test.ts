import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Google sign-in landing (/auth/callback) sends the person to ?next= after a good code exchange: never another site. */
const exchange = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { exchangeCodeForSession: exchange } }) }));
vi.mock("@/lib/report", () => ({ reportAuthError: vi.fn() }));
const { GET } = await import("./route");

const ORIGIN = "https://courtbook.example";
async function land(next: string): Promise<URL> {
  const res = await GET(new Request(`${ORIGIN}/auth/callback?code=abc&next=${encodeURIComponent(next)}`));
  return new URL(res.headers.get("location")!, ORIGIN);
}
beforeEach(() => { exchange.mockReset(); exchange.mockResolvedValue({ error: null }); });

describe("auth callback: where a signed-in person lands", () => {
  it("the page they came from, on this site", async () => {
    const u = await land("/club/batroun?date=2026-12-01");
    expect(u.origin).toBe(ORIGIN);
    expect(u.pathname + u.search).toBe("/club/batroun?date=2026-12-01");
  });
  for (const attack of ["/\\evil.example", "/\t/evil.example", "//evil.example", "https://evil.example", "/%5Cevil.example"]) {
    it(`stays on this site for next=${JSON.stringify(attack)}`, async () => {
      expect((await land(attack)).origin).toBe(ORIGIN);
    });
  }
  it("a failed exchange goes back to sign-in", async () => {
    exchange.mockResolvedValue({ error: { message: "bad" } });
    const u = await land("/me");
    expect(u.origin + u.pathname + u.search).toBe(`${ORIGIN}/login?error=link`);
  });
});
