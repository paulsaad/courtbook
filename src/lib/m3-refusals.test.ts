import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { friendlyError } from "./types";

// Website compatibility with migration 0072 (M3-H): every refusal 0072 introduces is shown as a
// sentence on the website, never as the raw code. (Refusals the earlier migrations already raised are
// unchanged by 0072 and out of scope here.)
const raised = (file: string) => new Set([...readFileSync(file, "utf8").matchAll(/raise exception '([a-z_]+)'/g)].map((m) => m[1]));
const before = new Set(readdirSync("supabase/migrations").filter((f) => f < "0072").flatMap((f) => [...raised(`supabase/migrations/${f}`)]));
const codes = [...raised("supabase/migrations/0072_game_hardening.sql")].filter((c) => !before.has(c)).sort();

describe("0072 refusals have website copy", () => {
  it("finds the new codes", () => expect(codes).toEqual(expect.arrayContaining(["court_lost", "club_required", "too_many_games", "slow_down"])));
  it.each(codes)("%s", (code) => {
    const shown = friendlyError(code);
    expect(shown).not.toBe(code);
    expect(shown).toMatch(/[A-Z].*\.$/);
  });
});
