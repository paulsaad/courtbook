import { act, render } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Text } from "react-native";

type Listener = (event: string, session: unknown) => void;
const mockAuth = { listener: null as Listener | null, initial: null as unknown, deletion: null as unknown, signOut: jest.fn(async (..._a: unknown[]) => ({ error: null })), rpc: jest.fn(async (..._a: unknown[]) => ({ data: null as unknown, error: null })) };
jest.mock("../lib/supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => mockAuth.rpc(...a),
    auth: {
      signOut: (...a: unknown[]) => mockAuth.signOut(...a),
      getSession: jest.fn(async () => ({ data: { session: mockAuth.initial } })),
      onAuthStateChange: jest.fn((cb: Listener) => {
        mockAuth.listener = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      }),
    },
  },
}));

import { cacheOwnerChanged, SessionProvider, useSession } from "../lib/session";

const session = (id: string) => ({ user: { id }, access_token: "t" });

function Status() {
  const s = useSession();
  return <Text>{s.status}</Text>;
}

async function mount(initial: unknown) {
  mockAuth.initial = initial;
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  qc.setQueryData(["my_agenda"], ["someone's booking"]);
  await render(
    <QueryClientProvider client={qc}>
      <SessionProvider><Status /></SessionProvider>
    </QueryClientProvider>
  );
  const emit = async (event: string, s: unknown) => act(async () => mockAuth.listener!(event, s));
  const cached = () => qc.getQueryData(["my_agenda"]);
  const refill = () => qc.setQueryData(["my_agenda"], ["someone's booking"]);
  return { emit, cached, refill };
}

describe("cacheOwnerChanged", () => {
  it.each([
    [undefined, "a", false], // cold start, reading the stored session
    [undefined, null, false],
    ["a", "a", false], // token refresh
    ["a", null, true], // sign-out, expiry, revocation
    ["a", "b", true], // a different account
    [null, "a", true], // signing in after being signed out
  ])("%s -> %s : %s", (prev, next, expected) => {
    expect(cacheOwnerChanged(prev as string | null | undefined, next as string | null)).toBe(expected);
  });
});

describe("SessionProvider clears cached user data on every auth change", () => {
  it("keeps the cache through a cold start and a token refresh", async () => {
    const { emit, cached } = await mount(session("a"));
    await emit("TOKEN_REFRESHED", session("a"));
    expect(cached()).toEqual(["someone's booking"]);
  });

  it("clears it when the session ends without anyone pressing sign out (expiry or revocation)", async () => {
    const { emit, cached } = await mount(session("a"));
    await emit("SIGNED_OUT", null);
    expect(cached()).toBeUndefined();
  });

  it("clears it when a different account signs in", async () => {
    const { emit, cached } = await mount(session("a"));
    await emit("SIGNED_IN", session("b"));
    expect(cached()).toBeUndefined();
  });

  it("clears what a signed-out visitor browsed when someone signs in", async () => {
    const { emit, cached } = await mount(null);
    await emit("SIGNED_IN", session("a"));
    expect(cached()).toBeUndefined();
  });
});

describe("SessionProvider signs out an account closed elsewhere (M2, 0086)", () => {
  beforeEach(() => {
    mockAuth.signOut.mockClear();
    mockAuth.rpc.mockReset();
    mockAuth.rpc.mockImplementation(async () => ({ data: mockAuth.deletion, error: null }));
  });
  it("cold start with a session for a closed account → signed out on this device", async () => {
    mockAuth.deletion = { status: "closed", closed: true };
    await mount(session("u1"));
    await act(async () => {});
    expect(mockAuth.rpc).toHaveBeenCalledWith("my_account_deletion", {});
    expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("an open account is left alone; a token refresh for the same person asks nothing", async () => {
    mockAuth.deletion = null;
    const { emit } = await mount(session("u1"));
    await act(async () => {});
    expect(mockAuth.rpc).toHaveBeenCalledTimes(1);
    await emit("TOKEN_REFRESHED", session("u1"));
    expect(mockAuth.rpc).toHaveBeenCalledTimes(1);
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });
  it("signed out: nothing is asked", async () => {
    await mount(null);
    await act(async () => {});
    expect(mockAuth.rpc).not.toHaveBeenCalled();
  });
  it("the check failing (offline, before 0079) changes nothing", async () => {
    mockAuth.rpc.mockImplementation(async () => { throw new TypeError("Network request failed"); });
    await mount(session("u1"));
    await act(async () => {});
    expect(mockAuth.signOut).not.toHaveBeenCalled();
  });
});
