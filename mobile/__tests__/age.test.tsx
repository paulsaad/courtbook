jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn() } }));
import { confirmAge, fetchAgeState } from "../lib/age";

const rpcOk = (data: unknown) => async () => ({ data, error: null });
describe("18+ status (0080)", () => {
  it("not confirmed: the question is needed (whatever the server switch says)", async () => {
    expect(await fetchAgeState(rpcOk({ confirmed: false, required: false }))).toBe("needed");
    expect(await fetchAgeState(rpcOk({ confirmed: false, required: true }))).toBe("needed");
  });
  it("confirmed: no question", async () => {
    expect(await fetchAgeState(rpcOk({ confirmed: true, required: true }))).toBe("confirmed");
  });
  it("before 0080 (function missing): no question", async () => {
    expect(await fetchAgeState(async () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }))).toBe("confirmed");
  });
  it("any other failure is thrown (asked again later), never read as confirmed or needed", async () => {
    await expect(fetchAgeState(async () => ({ data: null, error: { code: "08006", message: "connection lost" } }))).rejects.toBeTruthy();
  });
  it("confirming sends yes and the app channel, and reports a failure in words", async () => {
    const calls: unknown[] = [];
    expect(await confirmAge(async (fn, args) => { calls.push([fn, args]); return { data: { confirmed: true }, error: null }; })).toBeNull();
    expect(calls).toEqual([["confirm_age", { p_is_18_or_over: true, p_via: "app" }]]);
    expect(await confirmAge(async () => ({ data: null, error: { message: "x" } }))).toMatch(/didn't work/);
  });
});
