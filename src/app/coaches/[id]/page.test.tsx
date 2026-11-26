// @vitest-environment jsdom
/**
 * Local pilot build, 26 Nov: /coaches/<a malformed id> (e.g. a link cut short when shared) showed "Couldn't load
 * this page … Check your connection and try again" and raised a server error, because the database refuses a
 * malformed UUID (22P02). That refusal is now "Not found"; any other failed read is still the error page
 * (src/app/failedReads.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMalformedId } from "@/lib/ids";

const calls: string[] = [];
const INVALID_UUID = { code: "22P02", message: 'invalid input syntax for type uuid: "xyz"' };
const isWellFormed = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
let lastId = "";
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    // as PostgREST answers: a malformed uuid argument is refused with Postgres 22P02
    rpc: async (fn: string) => { calls.push(fn); return isWellFormed(lastId) ? { data: [], error: null } : { data: null, error: INVALID_UUID }; },
    from: () => { calls.push("from"); const b: Record<string, unknown> = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: null, error: null }); return b; },
  }),
}));
import CoachPage from "./page";

const page = (id: string) => (lastId = id, CoachPage)({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
beforeEach(() => { calls.length = 0; });

describe("coach page address", () => {
  it.each(["xyz", "04692734-bb44-4d88-a171", "04692734-bb44-4d88-a171-fe1854f2c33Z"])("malformed id %s → Not found, not a failed read", async (id) => {
    await expect(page(id)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls).toEqual(["coach_card"]);
  });
  it("a well-formed id is looked up (and an unknown one is Not found as before)", async () => {
    await expect(page("04692734-bb44-4d88-a171-fe1854f2c332")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls).toEqual(["coach_card"]);
  });
  it("isMalformedId: only the invalid-text refusal", () => {
    expect(isMalformedId(INVALID_UUID)).toBe(true);
    for (const e of [null, undefined, { code: "08006", message: "connection lost" }, { code: "PGRST116" }, { message: "TypeError: Failed to fetch" }]) expect(isMalformedId(e)).toBe(false);
  });
});
