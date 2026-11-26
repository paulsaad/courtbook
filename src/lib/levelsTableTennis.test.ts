import { describe, expect, it } from "vitest";
import { GUIDE, GUIDED_SPORTS } from "./levels";

describe("table tennis level guide (F14, draft for Paul's review)", () => {
  it("has ten levels, 1 to 10, like every other guided sport", () => {
    expect(GUIDED_SPORTS).toContain("table_tennis");
    expect(GUIDE.table_tennis.levels.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(GUIDE.table_tennis.intro).toMatch(/ping pong/i);
  });
});
