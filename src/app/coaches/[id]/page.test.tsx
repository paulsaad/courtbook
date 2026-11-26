// @vitest-environment jsdom
/**
 * Local pilot build, 26 Nov: /coaches/<a malformed id> (e.g. a link cut short when shared) showed "Couldn't load
 * this page … Check your connection and try again" and raised a server error, because the database refuses a
 * malformed UUID. It is now "Not found", with no database call.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isUuid } from "@/lib/ids";

const calls: string[] = [];
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async (fn: string) => { calls.push(fn); return { data: [], error: null }; },
    from: () => { calls.push("from"); const b: Record<string, unknown> = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: null, error: null }); return b; },
  }),
}));
import CoachPage from "./page";

const page = (id: string) => CoachPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
beforeEach(() => { calls.length = 0; });

describe("coach page address", () => {
  it.each(["xyz", "04692734-bb44-4d88-a171", "04692734-bb44-4d88-a171-fe1854f2c33Z"])("malformed id %s → Not found, nothing read", async (id) => {
    await expect(page(id)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls).toEqual([]);
  });
  it("a well-formed id is looked up (and an unknown one is Not found as before)", async () => {
    await expect(page("04692734-bb44-4d88-a171-fe1854f2c332")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls).toEqual(["coach_card"]);
  });
  it("isUuid", () => {
    expect(isUuid("04692734-BB44-4d88-a171-fe1854f2c332")).toBe(true);
    for (const s of ["", null, undefined, "04692734bb444d88a171fe1854f2c332", " 04692734-bb44-4d88-a171-fe1854f2c332"]) expect(isUuid(s)).toBe(false);
  });
});
