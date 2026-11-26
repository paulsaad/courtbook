import { describe, expect, it } from "vitest";
import { codeLabel, codeList, defaultLength, nextHeading } from "./labels";

describe("codes shown as words on player screens", () => {
  it("sports and levels get a capital first letter", () => {
    expect(codeLabel("padel")).toBe("Padel");
    expect(codeLabel("beginner")).toBe("Beginner");
    expect(codeLabel("other")).toBe("Other");
  });
  it("a code of two words (a sport added later)", () => expect(codeLabel("table_tennis")).toBe("Table tennis"));
  it("lists", () => {
    expect(codeList(["padel", "tennis"])).toBe("Padel, Tennis");
    expect(codeList(["beginner", "intermediate"])).toBe("Beginner, Intermediate");
    expect(codeList([])).toBe("");
    expect(codeList(null)).toBe("");
  });
  it("empty stays empty", () => {
    expect(codeLabel("")).toBe("");
    expect(codeLabel(null)).toBe("");
  });
});

describe("Home heading over the next item (matches the app's 'Your next booking')", () => {
  it("a court booking", () => expect(nextHeading("booking")).toBe("Your next booking"));
  it("a match", () => expect(nextHeading("match")).toBe("Your next game"));
});

describe("a new booking selection starts at 1 h wherever the club allows it (Paul, 26 Nov; the app does the same)", () => {
  it("1 h allowed", () => { expect(defaultLength([30, 60, 90], 30)).toBe(60); expect(defaultLength([60, 90, 120], 60)).toBe(60); });
  it("minimum above 1 h: the shortest", () => expect(defaultLength([90, 120], 90)).toBe(90));
  it("1 h not offered here (e.g. only 30 min free): the shortest", () => expect(defaultLength([30], 30)).toBe(30));
  it("nothing allowed: the fallback", () => expect(defaultLength([], 60)).toBe(60));
});
