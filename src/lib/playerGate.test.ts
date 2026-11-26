import { describe, expect, it } from "vitest";
import { LoadError } from "@/lib/load";
import { clubReturnPath, playerGatePath, safeNext } from "./playerGate";

type Res = { data: unknown; error: { code?: string; message?: string } | null };
function client(profile: Res, age: Res) {
  const q = { select: () => q, eq: () => q, single: () => Promise.resolve(profile) };
  return { from: () => q, rpc: async () => age } as unknown as Parameters<typeof playerGatePath>[0];
}
const ok = (data: unknown): Res => ({ data, error: null });

describe("playerGatePath (18+ and first-time profile)", () => {
  it("no name yet: the profile step first, with the way back", async () => {
    expect(await playerGatePath(client(ok({ name: null }), ok({ confirmed: false })), "u", "/club/batroun?at=x")).toBe("/profile?next=%2Fclub%2Fbatroun%3Fat%3Dx");
  });
  it("named but not confirmed 18+: the age step", async () => {
    expect(await playerGatePath(client(ok({ name: "A" }), ok({ confirmed: false, required: true })), "u", "/play")).toBe("/age?next=%2Fplay");
  });
  it("asked even while the server does not enforce it yet (new clients ask first)", async () => {
    expect(await playerGatePath(client(ok({ name: "A" }), ok({ confirmed: false, required: false })), "u", "/play")).toBe("/age?next=%2Fplay");
  });
  it("confirmed: no gate", async () => {
    expect(await playerGatePath(client(ok({ name: "A" }), ok({ confirmed: true })), "u", "/play")).toBeNull();
  });
  it("before 0080 (function missing): no age step", async () => {
    expect(await playerGatePath(client(ok({ name: "A" }), { data: null, error: { code: "PGRST202", message: "Could not find the function" } }), "u", "/play")).toBeNull();
  });
  it("any other failure stops the page (never treated as confirmed)", async () => {
    await expect(playerGatePath(client(ok({ name: "A" }), { data: null, error: { code: "08006", message: "connection lost" } }), "u", "/play")).rejects.toBeInstanceOf(LoadError);
  });
  it("browsing clubs and courts (requireName false): no name is asked, the 18+ step still is (N6)", async () => {
    expect(await playerGatePath(client(ok({ name: null }), ok({ confirmed: true })), "u", "/club/batroun", "this club", { requireName: false })).toBeNull();
    expect(await playerGatePath(client(ok({ name: null }), ok({ confirmed: false })), "u", "/club/batroun", "this club", { requireName: false })).toBe("/age?next=%2Fclub%2Fbatroun");
  });
  it("games and chat (default): still the profile step first", async () => {
    expect(await playerGatePath(client(ok({ name: null }), ok({ confirmed: true })), "u", "/play")).toBe("/profile?next=%2Fplay");
  });
  it("the club page's way back keeps the chosen date and selection (N6: the date was dropped)", () => {
    expect(clubReturnPath("batroun", { date: "2026-12-01" })).toBe("/club/batroun?date=2026-12-01");
    expect(clubReturnPath("batroun", { date: "2026-12-01", at: "2026-12-01T16:00:00.000Z", court: "k1", dur: "60" }))
      .toBe("/club/batroun?date=2026-12-01&at=2026-12-01T16%3A00%3A00.000Z&court=k1&dur=60");
    expect(clubReturnPath("batroun", {})).toBe("/club/batroun");
  });
  it("the way back stays on this site", () => {
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "", null, undefined]) expect(safeNext(bad)).toBe("/");
    expect(safeNext("/club/x?y=1")).toBe("/club/x?y=1");
  });
});
