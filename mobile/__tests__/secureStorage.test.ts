const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (k: string) => (mockStore.has(k) ? mockStore.get(k)! : null)),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    if (v.length > 2048) throw new Error("value too large for SecureStore");
    mockStore.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
}));

import { ChunkedSecureStore } from "../lib/secureStorage";

beforeEach(() => mockStore.clear());

describe("ChunkedSecureStore", () => {
  it("round-trips a session far larger than SecureStore's limit", async () => {
    const session = JSON.stringify({ access_token: "a".repeat(5000), refresh_token: "r".repeat(300), user: { id: "u" } });
    await ChunkedSecureStore.setItem("sb-auth-token", session);
    expect(await ChunkedSecureStore.getItem("sb-auth-token")).toBe(session);
  });

  it("removes chunks left over from a longer previous value", async () => {
    await ChunkedSecureStore.setItem("k", "x".repeat(5000));
    await ChunkedSecureStore.setItem("k", "short");
    expect(await ChunkedSecureStore.getItem("k")).toBe("short");
    expect([...mockStore.keys()].sort()).toEqual(["k__0", "k__n"]);
  });

  it("reads a torn value as absent, not as a truncated session", async () => {
    await ChunkedSecureStore.setItem("k", "y".repeat(4000));
    mockStore.delete("k__1");
    expect(await ChunkedSecureStore.getItem("k")).toBeNull();
  });

  it("removeItem clears every chunk", async () => {
    await ChunkedSecureStore.setItem("k", "z".repeat(4000));
    await ChunkedSecureStore.removeItem("k");
    expect(mockStore.size).toBe(0);
    expect(await ChunkedSecureStore.getItem("k")).toBeNull();
  });
});
