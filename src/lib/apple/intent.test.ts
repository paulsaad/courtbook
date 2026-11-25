import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { INTENT_TTL_S, intentSecret, signIntent, verifyIntent } from "./intent";

const SECRET = "s".repeat(40);
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const NOW = new Date("2026-11-25T15:00:00Z");

describe("deletion intent", () => {
  it("issued to an account, verified back to that account", () => {
    expect(verifyIntent(SECRET, signIntent(SECRET, A, NOW), NOW)).toEqual({ ok: true, userId: A });
  });
  it("expires after its lifetime; not valid from the future", () => {
    const t = signIntent(SECRET, A, NOW);
    expect(verifyIntent(SECRET, t, new Date(NOW.getTime() + (INTENT_TTL_S - 1) * 1000))).toMatchObject({ ok: true });
    expect(verifyIntent(SECRET, t, new Date(NOW.getTime() + INTENT_TTL_S * 1000))).toEqual({ ok: false, code: "intent_expired" });
    expect(verifyIntent(SECRET, signIntent(SECRET, A, new Date(NOW.getTime() + 3600_000)), NOW)).toEqual({ ok: false, code: "intent_expired" });
  });
  it("another secret, a changed account id, a cut or padded token: invalid", () => {
    const t = signIntent(SECRET, A, NOW);
    expect(verifyIntent("t".repeat(40), t, NOW)).toEqual({ ok: false, code: "intent_invalid" });
    const [body, sig] = t.split(".");
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), u: "bbbbbbbb-0000-4000-8000-00000000000b" })).toString("base64url");
    expect(verifyIntent(SECRET, `${other}.${sig}`, NOW)).toEqual({ ok: false, code: "intent_invalid" });
    for (const bad of [body, `${t}.x`, "", null, 5, "x".repeat(600)]) expect(verifyIntent(SECRET, bad, NOW)).toEqual({ ok: false, code: "intent_invalid" });
  });
  it("two intents for the same account differ (random part)", () => {
    expect(signIntent(SECRET, A, NOW)).not.toBe(signIntent(SECRET, A, NOW));
  });
  it("the secret must be configured and long enough; otherwise none", () => {
    expect(intentSecret({})).toBeNull();
    expect(intentSecret({ DELETION_INTENT_SECRET: "short" })).toBeNull();
    expect(intentSecret({ DELETION_INTENT_SECRET: SECRET })).toBe(SECRET);
  });
});
