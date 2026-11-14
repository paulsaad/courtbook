import { act, render } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Text } from "react-native";

type Listener = (event: string, session: unknown) => void;
const mockAuth = { listener: null as Listener | null, initial: null as unknown };
jest.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
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
