jest.mock("../lib/supabase", () => ({ supabase: {} }));
import { choosable, KNOWN_SPORTS, nameOf, sortByName } from "../lib/sports";
import { sportName } from "../lib/days";

describe("sports catalogue (F14–F16)", () => {
  it("lists active sports alphabetically by display name, without 'Other'", () => {
    const rows = [
      { code: "tennis", name_en: "Tennis", active: true },
      { code: "table_tennis", name_en: "Table tennis", active: true },
      { code: "other", name_en: "Other", active: true },
      { code: "badminton", name_en: "Badminton", active: true },
      { code: "squash", name_en: "Squash", active: false },
      { code: "padel", name_en: "Padel", active: true },
    ];
    expect(choosable(rows).map((s) => s.code)).toEqual(["badminton", "padel", "table_tennis", "tennis"]);
  });
  it("a sport added by an admin later appears with its own name, no app update", () => {
    expect(choosable([{ code: "cricket", name_en: "Cricket", active: true }, { code: "padel", name_en: "Padel", active: true }]))
      .toEqual([{ code: "cricket", name: "Cricket" }, { code: "padel", name: "Padel" }]);
  });
  it("falls back to the sports this version knows, alphabetically, when the catalogue is empty or unavailable", () => {
    expect(choosable(null)).toBe(KNOWN_SPORTS);
    expect(KNOWN_SPORTS.map((s) => s.name)).toEqual([...KNOWN_SPORTS.map((s) => s.name)].sort((a, b) => a.localeCompare(b)));
    // I-7: table tennis starts inactive, so the offline fallback never offers it; the catalogue does once activated
    expect(KNOWN_SPORTS.some((s) => s.code === "table_tennis")).toBe(false);
    expect(choosable([{ code: "table_tennis", name_en: "Table tennis", active: true }]).map((s) => s.code)).toEqual(["table_tennis"]);
    expect(choosable([{ code: "padel", name_en: "Padel", active: true }, { code: "table_tennis", name_en: "Table tennis", active: false }]).map((s) => s.code)).toEqual(["padel"]);
  });
  it("readable names for codes with underscores; the catalogue name wins", () => {
    expect(sportName("table_tennis")).toBe("Table tennis");
    expect(sportName("padel")).toBe("Padel");
    expect(sportName("other")).toBe("Other");
    expect(nameOf("table_tennis", [{ code: "table_tennis", name: "Ping pong (table tennis)" }])).toBe("Ping pong (table tennis)");
    expect(nameOf("curling", [])).toBe("Curling");
  });
  it("sorting ignores case", () => {
    expect(sortByName([{ code: "b", name: "beta" }, { code: "a", name: "Alpha" }]).map((s) => s.code)).toEqual(["a", "b"]);
  });
});
