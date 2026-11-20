import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERRORS, friendlyError } from "./types";

// Website compatibility with the M3 migrations: every refusal 0072, 0073 or 0074 introduces is shown
// as a sentence on the website, never as the raw code. (Refusals the earlier migrations already raised
// are out of scope here.)
const raised = (file: string) => new Set([...readFileSync(file, "utf8").matchAll(/raise exception '([a-z_]+)'/g)].map((m) => m[1]));
const files = readdirSync("supabase/migrations").sort();
const newIn = (prefix: string) => {
  const before = new Set(files.filter((f) => f < prefix).flatMap((f) => [...raised(`supabase/migrations/${f}`)]));
  const file = files.find((f) => f.startsWith(prefix));
  return file ? [...raised(`supabase/migrations/${file}`)].filter((c) => !before.has(c)).sort() : [];
};
const codes = [...new Set([...newIn("0072"), ...newIn("0073"), ...newIn("0074")])].sort();

describe("M3 refusals have website copy", () => {
  it("finds the new codes", () => expect(codes).toEqual(expect.arrayContaining(["court_lost", "too_many_games", "slow_down", "blocked", "account_suspended", "rules_not_accepted"])));
  it.each(codes)("%s", (code) => {
    const shown = friendlyError(code);
    expect(shown).not.toBe(code);
    expect(shown).toMatch(/[A-Z].*\.$/);
  });
});

describe("a code is never shown with a shorter code's sentence", () => {
  it.each(Object.keys(ERRORS))("%s", (code) => expect(friendlyError(`ERROR: ${code}`)).toBe(ERRORS[code]));
});
