// @vitest-environment jsdom
/**
 * H1 (Session B's handover, 26 Nov): /bookings/<malformed>, /pay/<malformed> and /matches/<malformed> (a link cut
 * short when shared, a typo) showed "Couldn't load this page … Check your connection" and raised a server error,
 * because the database refuses a malformed UUID (22P02). Now "Not found", as the coach page (#78). Any other failed
 * read is still the error page (src/app/failedReads.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const INVALID_UUID = { code: "22P02", message: 'invalid input syntax for type uuid: "xyz"' };
const LOST = { code: "08006", message: "connection lost" };
let answer: { data: unknown; error: unknown } = { data: null, error: INVALID_UUID };
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
}));
vi.mock("@/lib/playerGate", () => ({ playerGatePath: async () => null }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async () => answer,
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq", "in", "order"]) b[m] = () => b; b.single = async () => answer; b.maybeSingle = async () => answer; return b; },
  }),
}));
import BookingPage from "./bookings/[id]/page";
import PayPage from "./pay/[id]/page";
import MatchPage from "./matches/[id]/page";

const params = (id: string) => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
const pages: [string, (p: ReturnType<typeof params>) => Promise<unknown>][] = [
  ["booking", (p) => BookingPage(p as never)], ["payment", (p) => PayPage(p as never)], ["game", (p) => MatchPage(p as never)],
];
beforeEach(() => { answer = { data: null, error: INVALID_UUID }; });

describe("a malformed id in a booking, payment or game link", () => {
  it.each(pages)("%s page: Not found, not a failed read", async (_name, page) => {
    await expect(page(params("not-a-uuid"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it.each(pages)("%s page: any other failed read is still the error page", async (_name, page) => {
    answer = { data: null, error: LOST };
    await expect(page(params("04692734-bb44-4d88-a171-fe1854f2c332"))).rejects.not.toThrow("NEXT_NOT_FOUND");
  });
});
