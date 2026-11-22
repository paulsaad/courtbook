import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HEALTH_COLUMN, databaseReachable } from "@/lib/health";

/** A fake Supabase client whose read resolves, fails or never answers. */
const fake = (outcome: "ok" | "error" | "hang" | "throw") => () => ({
  from: () => ({ select: () => ({ limit: () => ({ abortSignal: (signal: AbortSignal) => {
    if (outcome === "throw") throw new Error("boom");
    if (outcome === "hang") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return Promise.resolve({ error: outcome === "error" ? { message: "x" } : null });
  } }) }) }),
}) as never;

describe("databaseReachable", () => {
  it("is true only when the read answers without error", async () => {
    expect(await databaseReachable(100, fake("ok"))).toBe(true);
    expect(await databaseReachable(100, fake("error"))).toBe(false);
    expect(await databaseReachable(100, fake("throw"))).toBe(false);
  });
  it("gives up after the time limit", async () => {
    const t = Date.now();
    expect(await databaseReachable(50, fake("hang"))).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("the health read matches the real database", () => {
  it("reads sports, a column that exists in the migrations, and nothing else", async () => {
    const calls: string[] = [];
    const recording = () => ({
      from: (t: string) => { calls.push(`from:${t}`); return { select: (c: string) => { calls.push(`select:${c}`); return { limit: () => ({ abortSignal: () => Promise.resolve({ error: null }) }) }; } }; },
    }) as never;
    expect(await databaseReachable(100, recording)).toBe(true);
    expect(calls).toEqual(["from:sports", `select:${HEALTH_COLUMN}`]);
    // the column is in the table definition (a fake client cannot catch a wrong column: found on the preview, 22 Nov)
    const dir = join(process.cwd(), "supabase/migrations");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const table = /create table sports \(([\s\S]*?)\);/i.exec(sql);
    expect(table, "sports table definition").not.toBeNull();
    expect(table![1]).toMatch(new RegExp(`^\\s*${HEALTH_COLUMN}\\s`, "m"));
    // and anonymous visitors may read it (0032)
    expect(sql).toMatch(/grant select on sports[^;]*to anon/i);
  });
});

describe("GET /api/health", () => {
  it("answers 200 {ok:true} or 503 {ok:false}, never cached, nothing else in the body", async () => {
    for (const ok of [true, false]) {
      vi.resetModules();
      vi.doMock("@/lib/health", () => ({ databaseReachable: async () => ok }));
      const { GET } = await import("./route");
      const r = await GET();
      expect(r.status).toBe(ok ? 200 : 503);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toEqual({ ok });
    }
  });
});
