import * as SecureStore from "expo-secure-store";

/**
 * SecureStore refuses to store values much over 2 KB, and a Supabase session
 * (access token + refresh token + user object) is routinely larger than that.
 * Storing it whole appears to work and then fails to come back after the app is
 * killed — which is exactly the thing the sign-in test is meant to prove.
 * So the value is split into numbered chunks, with a header recording the count.
 */
const CHUNK = 1800;

const stripKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "_");

async function readCount(key: string): Promise<number> {
  const head = await SecureStore.getItemAsync(`${key}__n`);
  const n = head === null ? NaN : Number(head);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

async function clearChunks(key: string, upTo: number) {
  for (let i = 0; i < upTo; i++) await SecureStore.deleteItemAsync(`${key}__${i}`);
  await SecureStore.deleteItemAsync(`${key}__n`);
}

export const ChunkedSecureStore = {
  async getItem(rawKey: string): Promise<string | null> {
    const key = stripKey(rawKey);
    const n = await readCount(key);
    if (n === 0) return null;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const part = await SecureStore.getItemAsync(`${key}__${i}`);
      // A missing chunk means the stored value is torn; treat it as absent
      // rather than returning a truncated string that will not parse.
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join("");
  },

  async setItem(rawKey: string, value: string): Promise<void> {
    const key = stripKey(rawKey);
    const previous = await readCount(key);
    const parts: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK) parts.push(value.slice(i, i + CHUNK));
    // Write the chunks first, then the count: a crash midway leaves the old
    // count pointing at chunks that still exist, not at chunks that do not.
    for (let i = 0; i < parts.length; i++) await SecureStore.setItemAsync(`${key}__${i}`, parts[i]);
    await SecureStore.setItemAsync(`${key}__n`, String(parts.length));
    for (let i = parts.length; i < previous; i++) await SecureStore.deleteItemAsync(`${key}__${i}`);
  },

  async removeItem(rawKey: string): Promise<void> {
    const key = stripKey(rawKey);
    await clearChunks(key, await readCount(key));
  },
};
