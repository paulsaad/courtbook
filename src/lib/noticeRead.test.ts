import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { markGameNoticesRead } from "./noticeRead";

// H11 (Paul, 26 Nov): opening game A marks only game A's notices read; game B's stay unread. Never p_ids: null.
type N = { id: string; profile_id: string; match_id: string | null; read_at: string | null };
function fake(rows: N[], opts: { failRead?: boolean; failMark?: boolean } = {}) {
  const calls: { fn: string; args: { p_ids: string[] | null } }[] = [];
  const client = {
    from: () => ({ select: () => ({ eq: (c1: string, v1: string) => ({ eq: (c2: string, v2: string) => ({ is: async () => {
      if (opts.failRead) return { data: null, error: { message: "TypeError: Failed to fetch" } };
      const f: Record<string, string> = { [c1]: v1, [c2]: v2 };
      return { data: rows.filter((r) => r.profile_id === f.profile_id && r.match_id === f.match_id && r.read_at === null).map((r) => ({ id: r.id })), error: null };
    } }) }) }) }),
    rpc: async (fn: string, args: { p_ids: string[] | null }) => {
      calls.push({ fn, args });
      if (opts.failMark) return { error: { message: "x" } };
      // mark_notifications_read (0025): the caller's own unread rows with those ids
      for (const r of rows) if (r.profile_id === "rana" && r.read_at === null && (args.p_ids === null || args.p_ids.includes(r.id))) r.read_at = "now";
      return { error: null };
    },
  };
  return { client: client as never, calls };
}
const rows = (): N[] => [
  { id: "a1", profile_id: "rana", match_id: "A", read_at: null },
  { id: "a2", profile_id: "rana", match_id: "A", read_at: null },
  { id: "a0", profile_id: "rana", match_id: "A", read_at: "earlier" },
  { id: "b1", profile_id: "rana", match_id: "B", read_at: null },
  { id: "n1", profile_id: "rana", match_id: null, read_at: null },          // a booking notice, no game
  { id: "k1", profile_id: "karim", match_id: "A", read_at: null },         // someone else's notice for game A
];

describe("markGameNoticesRead (H11)", () => {
  it("1–2: opening game A marks exactly A's own unread notices; B's and other notices stay unread", async () => {
    const t = rows(); const { client, calls } = fake(t);
    expect(await markGameNoticesRead(client, "rana", "A")).toEqual(["a1", "a2"]);
    expect(calls).toEqual([{ fn: "mark_notifications_read", args: { p_ids: ["a1", "a2"] } }]);
    expect(t.find((r) => r.id === "b1")!.read_at).toBeNull();
    expect(t.find((r) => r.id === "n1")!.read_at).toBeNull();
    expect(t.find((r) => r.id === "k1")!.read_at).toBeNull();
  });
  it("3: a second visit or a #91 refresh of game A with nothing new calls nothing, and B stays unread", async () => {
    const t = rows(); const { client, calls } = fake(t);
    await markGameNoticesRead(client, "rana", "A");
    calls.length = 0;
    expect(await markGameNoticesRead(client, "rana", "A")).toEqual([]);
    expect(calls).toEqual([]);
    expect(t.filter((r) => r.profile_id === "rana" && r.read_at === null).map((r) => r.id)).toEqual(["b1", "n1"]);
  });
  it("never passes null, even when the read fails; a failure is silent and marks nothing", async () => {
    for (const o of [{ failRead: true }, { failMark: true }]) {
      const t = rows(); const { client, calls } = fake(t, o);
      expect(await markGameNoticesRead(client, "rana", "A")).toEqual([]);
      expect(calls.every((c) => Array.isArray(c.args.p_ids) && c.args.p_ids.length > 0)).toBe(true);
    }
  });
  it("a thrown error (no connection on the server) never breaks the page", async () => {
    const client = { from: () => { throw new Error("boom"); }, rpc: vi.fn() } as never;
    expect(await markGameNoticesRead(client, "rana", "A")).toEqual([]);
  });
  it("the game page uses it with its own game id and never calls mark_notifications_read with null", () => {
    const page = readFileSync("src/app/matches/[id]/page.tsx", "utf8");
    expect(page).toContain("markGameNoticesRead(supabase as never, user.id, id)");
    expect(page).not.toMatch(/mark_notifications_read/);
    expect(page).toContain("<NoticesRead marked={marked.join(\",\")} />");
  });
});
