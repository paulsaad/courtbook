jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn() } }));
import { act, renderHook } from "@testing-library/react-native";
import { onlineManager } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { CANCEL_MESSAGES, useCancellation } from "../lib/cancel";

const rpc = supabase.rpc as jest.Mock;
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });

beforeEach(() => { rpc.mockReset(); onlineManager.setOnline(true); });

async function setup(statuses: (string | "unreachable")[]) {
  const read = jest.fn(async () => statuses.shift() ?? "confirmed");
  const view = await renderHook(() => useCancellation({ bookingId: "b1", read }));
  return { view, read };
}

it("offline: sends nothing, booking unchanged", async () => {
  onlineManager.setOnline(false);
  const { view } = await setup([]);
  await act(async () => { await view.result.current.submit(); });
  expect(rpc).not.toHaveBeenCalled();
  expect(view.result.current.problem).toBe(CANCEL_MESSAGES.offline);
});

it("connection drops mid-request: shows the database's status once back online (it did cancel)", async () => {
  rpc.mockImplementationOnce(() => { onlineManager.setOnline(false); return Promise.resolve({ data: null, error: { message: "TypeError: Network request failed", code: "" } }); });
  const { view, read } = await setup(["cancelled"]);
  await act(async () => { await view.result.current.submit(); });
  expect(view.result.current.phase).toBe("uncertain");
  expect(read).not.toHaveBeenCalled();
  await act(async () => { onlineManager.setOnline(true); });
  await flush();
  expect(read).toHaveBeenCalledTimes(1);
  expect(view.result.current.phase).toBe("idle");
  expect(view.result.current.problem).toBeNull();
});

it("connection drops mid-request and the cancel never arrived: says the booking is still active", async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: "AbortError: Aborted", code: "" } });
  const { view } = await setup(["confirmed"]);
  await act(async () => { await view.result.current.submit(); });
  await flush();
  expect(view.result.current.phase).toBe("idle");
  expect(view.result.current.problem).toBe(CANCEL_MESSAGES.stillActive);
});

it("re-read also fails: stays uncertain rather than guessing", async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: "TypeError: Network request failed", code: "" } });
  const { view } = await setup(["unreachable"]);
  await act(async () => { await view.result.current.submit(); });
  await flush();
  expect(view.result.current.phase).toBe("uncertain");
  expect(view.result.current.problem).toBe(CANCEL_MESSAGES.uncertain);
});

it("a retry answered 'no longer active' re-reads the booking instead of showing an error", async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { message: "not_confirmed", code: "P0001" } });
  const { view, read } = await setup(["cancelled"]);
  await act(async () => { await view.result.current.submit(); });
  await flush();
  expect(read).toHaveBeenCalled();
  expect(view.result.current.problem).toBeNull();
});
