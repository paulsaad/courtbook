import { describe, expect, it } from "vitest";
import { codeLabel, codeList, nextHeading } from "./labels";

describe("codes shown as words on player screens", () => {
  it("sports and levels get a capital first letter", () => {
    expect(codeLabel("padel")).toBe("Padel");
    expect(codeLabel("beginner")).toBe("Beginner");
    expect(codeLabel("other")).toBe("Other");
  });
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
