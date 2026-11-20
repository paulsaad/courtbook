jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), auth: { signOut: jest.fn() } } }));
import { QueryClient } from "@tanstack/react-query";
import { BLOCKED_ACCEPT, runGameAction } from "../lib/gameActions";
import { GAME_ERRORS } from "../lib/gameErrors";

// M3-S: `blocked` is raised for a join (joiner's sentence) and for an organiser's accept (this one).
const refuse = async () => ({ data: null, error: { message: "blocked", code: "P0001" } });

describe("blocked refusal copy by action", () => {
  it("the organiser accepting reads 'can't accept this player'", async () => {
    const out = await runGameAction(new QueryClient(), "g1", { kind: "decide", profileId: "p", accept: true }, { available: true, rpc: refuse });
    expect(out).toEqual({ kind: "refused", failure: expect.objectContaining({ reason: "blocked", message: BLOCKED_ACCEPT }) });
  });
  it("the joiner reads the shared sentence", async () => {
    const out = await runGameAction(new QueryClient(), "g2", { kind: "join" }, { available: true, rpc: refuse });
    expect(out.kind === "refused" && out.failure.message).toBe(GAME_ERRORS.blocked);
  });
  it("a suspended account is explained, not a generic error", async () => {
    const out = await runGameAction(new QueryClient(), "g3", { kind: "join" }, { available: true, rpc: async () => ({ data: null, error: { message: "account_suspended", code: "P0001" } }) });
    expect(out.kind === "refused" && out.failure.message).toMatch(/suspended/);
  });
});
