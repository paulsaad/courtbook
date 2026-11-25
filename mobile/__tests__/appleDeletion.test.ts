// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash } = require("crypto") as { createHash: (a: string) => { update: (s: string) => { digest: (e: "hex") => string } } };
import {
  appleDeletionOn, deleteWithApple, deleteWithFallback, MISMATCH_TEXT,
  type AppleDeletionDeps, type ApiAnswer, type Session,
} from "../lib/appleDeletion";
import { CLOSE_MESSAGES } from "../lib/accountClosing";

/**
 * E1 app side (draft, off): the native Supabase authentication handoff and the account-switching guard (third review
 * 25 Nov, point 1), against fakes — no Apple, no Supabase, no network.
 */
const A: Session = { userId: "aaaaaaaa-0000-4000-8000-00000000000a", accessToken: "token-A-main" };
type Opt = {
  sheet?: { identityToken: string; authorizationCode: string } | "cancelled" | "unavailable";
  freshUser?: string | null; intent?: ApiAnswer; del?: ApiAnswer; closedNow?: boolean | null; main?: Session | null;
};
function fake(o: Opt = {}) {
  const log: string[] = [];
  const posts: { path: string; token: string; body?: Record<string, string> }[] = [];
  let hashedGiven = "";
  let rawGiven = "";
  const freshSignOut = jest.fn(async () => { log.push("fresh.signOut"); });
  const d: AppleDeletionDeps = {
    mainSession: async () => (o.main === undefined ? A : o.main),
    post: async (path, token, body) => {
      posts.push({ path, token, body }); log.push(`post:${path}`);
      if (path === "/api/account/apple-delete/intent") return o.intent === undefined ? { status: 200, body: { intent: "intent-for-A" } } : o.intent;
      return o.del === undefined ? { status: 200, body: { closed: true, revocation: "done" } } : o.del;
    },
    nonce: async () => {
      const raw = "raw-nonce-123";
      return { raw, hashed: createHash("sha256").update(raw).digest("hex") };
    },
    appleSheet: async (hashed) => { hashedGiven = hashed; log.push("apple.sheet"); return o.sheet ?? { identityToken: "apple-id-token", authorizationCode: "apple-code" }; },
    freshSignIn: async (token, raw) => {
      rawGiven = raw; log.push(`fresh.signIn:${token}`);
      const u = o.freshUser === undefined ? A.userId : o.freshUser;
      return u ? { userId: u, accessToken: `token-${u}-fresh`, signOut: freshSignOut } : null;
    },
    closedNow: async () => { log.push("closedNow"); return o.closedNow === undefined ? null : o.closedNow; },
    signOutEverywhere: async () => { log.push("main.signOutEverywhere"); },
  };
  return { d, log, posts, freshSignOut, nonces: () => ({ hashedGiven, rawGiven }) };
}

describe("the native Supabase authentication handoff", () => {
  it("intent with the ORIGINAL session → Apple sheet (hashed nonce) → Supabase sign-in on the side (token + RAW nonce) → server with the FRESH session", async () => {
    const f = fake();
    expect(await deleteWithApple(f.d)).toEqual({ kind: "closed", revocation: "done" });
    expect(f.log).toEqual(["post:/api/account/apple-delete/intent", "apple.sheet", "fresh.signIn:apple-id-token", "post:/api/account/apple-delete", "main.signOutEverywhere"]);
    expect(f.posts[0]).toEqual({ path: "/api/account/apple-delete/intent", token: "token-A-main", body: undefined });
    expect(f.posts[1]).toEqual({ path: "/api/account/apple-delete", token: `token-${A.userId}-fresh`, body: { method: "apple", code: "apple-code", intent: "intent-for-A" } });
    // Apple got the SHA-256 of exactly the raw nonce Supabase got: Supabase can match the token to this sign-in
    const { hashedGiven, rawGiven } = f.nonces();
    expect(createHash("sha256").update(rawGiven).digest("hex")).toBe(hashedGiven);
    expect(rawGiven).not.toBe(hashedGiven);
  });
  it("the app sends no Apple user id and no CourtBook user id to the server; only code, intent and method", async () => {
    const f = fake();
    await deleteWithApple(f.d);
    expect(Object.keys(f.posts[1].body ?? {}).sort()).toEqual(["code", "intent", "method"]);
  });
});

describe("third review, point 1: two Apple accounts — no account switching", () => {
  it("the Apple sheet signs into account B: the app stops, signs the side session out, never calls the server, keeps its own session", async () => {
    const f = fake({ freshUser: "bbbbbbbb-0000-4000-8000-00000000000b" });
    expect(await deleteWithApple(f.d)).toEqual({ kind: "account_mismatch" });
    expect(f.posts.map((p) => p.path)).toEqual(["/api/account/apple-delete/intent"]);   // no deletion call
    expect(f.freshSignOut).toHaveBeenCalledTimes(1);
    expect(f.log).not.toContain("main.signOutEverywhere");
    expect(MISMATCH_TEXT).toMatch(/nothing was deleted/);
  });
  it("if the server says account_mismatch anyway, the app reports it the same way", async () => {
    const f = fake({ del: { status: 403, body: { closed: false, error: "account_mismatch" } } });
    expect(await deleteWithApple(f.d)).toEqual({ kind: "account_mismatch" });
    expect(f.freshSignOut).toHaveBeenCalled();
  });
});

describe("cancellation, outages and the fallback", () => {
  it("Apple cancelled or unavailable, or Supabase refusing the token: offer the email-code fallback; nothing else happens", async () => {
    for (const [o, reason] of [[{ sheet: "cancelled" as const }, "cancelled"], [{ sheet: "unavailable" as const }, "apple_unavailable"], [{ freshUser: null }, "apple_unavailable"]] as const) {
      const f = fake(o);
      expect(await deleteWithApple(f.d)).toEqual({ kind: "use_fallback", intent: "intent-for-A", reason });
      expect(f.posts.map((p) => p.path)).toEqual(["/api/account/apple-delete/intent"]);
    }
  });
  it("the fallback (after the email code on the app's own session): the same intent, the app's own token", async () => {
    const f = fake({ del: { status: 200, body: { closed: true, revocation: "skipped" } } });
    expect(await deleteWithFallback(f.d, "intent-for-A")).toEqual({ kind: "closed", revocation: "skipped" });
    expect(f.posts[0]).toEqual({ path: "/api/account/apple-delete", token: "token-A-main", body: { method: "fallback", intent: "intent-for-A" } });
  });
  it("the server feature off (503 at the intent): the existing deletion flow is used; no Apple sheet", async () => {
    const f = fake({ intent: { status: 503, body: { error: "not_configured" } } });
    expect(await deleteWithApple(f.d)).toEqual({ kind: "not_configured" });
    expect(f.log).not.toContain("apple.sheet");
  });
  it("not signed in, or no intent: refused, nothing else", async () => {
    expect((await deleteWithApple(fake({ main: null }).d)).kind).toBe("refused");
    const f = fake({ intent: null });
    expect((await deleteWithApple(f.d)).kind).toBe("refused");
    expect(f.log).not.toContain("apple.sheet");
  });
});

describe("answers from the server, including a lost one", () => {
  it("lost answer: the app's own deletion status decides; not confirmed closed is 'unknown', never 'nothing changed'", async () => {
    let f = fake({ del: null, closedNow: true });
    expect(await deleteWithApple(f.d)).toEqual({ kind: "closed", revocation: "failed" });
    expect(f.log).toContain("main.signOutEverywhere");
    for (const closedNow of [false, null]) {
      f = fake({ del: null, closedNow });
      expect(await deleteWithApple(f.d)).toEqual({ kind: "unknown" });
      expect(f.log).not.toContain("main.signOutEverywhere");
    }
  });
  it("the server's own 'unknown' (202): the same check", async () => {
    expect(await deleteWithApple(fake({ del: { status: 202, body: { closed: "unknown" } }, closedNow: false }).d)).toEqual({ kind: "unknown" });
    expect(await deleteWithApple(fake({ del: { status: 202, body: { closed: "unknown" } }, closedNow: true }).d)).toEqual({ kind: "closed", revocation: "failed" });
  });
  it("definite refusals use the existing wording; the side session is signed out; the app's own is kept", async () => {
    const f = fake({ del: { status: 409, body: { closed: false, error: "staff_role" } } });
    expect(await deleteWithApple(f.d)).toEqual({ kind: "refused", message: CLOSE_MESSAGES.staff_role });
    expect(f.freshSignOut).toHaveBeenCalled();
    expect(f.log).not.toContain("main.signOutEverywhere");
    expect((await deleteWithApple(fake({ del: { status: 422, body: { closed: false, error: "wrong_apple_account" } } }).d))).toEqual({ kind: "refused", message: MISMATCH_TEXT });
  });
  it("a closed answer with revocation failed or skipped is still closed (the screen adds how to remove CourtBook from the Apple ID)", async () => {
    for (const revocation of ["failed", "skipped"]) {
      expect(await deleteWithApple(fake({ del: { status: 200, body: { closed: true, revocation } } }).d)).toEqual({ kind: "closed", revocation });
    }
  });
});

describe("switch", () => {
  it("on only with EXPO_PUBLIC_APPLE_DELETION=1, on iOS, for an account with an Apple identity", () => {
    const apple = { identities: [{ provider: "email" }, { provider: "apple" }] };
    expect(appleDeletionOn("1", "ios", apple)).toBe(true);
    expect(appleDeletionOn(undefined, "ios", apple)).toBe(false);
    expect(appleDeletionOn("true", "ios", apple)).toBe(false);
    expect(appleDeletionOn("1", "android", apple)).toBe(false);
    expect(appleDeletionOn("1", "ios", { identities: [{ provider: "email" }] })).toBe(false);
    expect(appleDeletionOn("1", "ios", null)).toBe(false);
  });
});
