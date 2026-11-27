import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PHONE_HELP, PHONE_PRIVACY, UNREADABLE, checkDetails, detailsPatch, detailsPath, missingForBooking, saveProblem, whyWeAsk } from "./playerDetails";

describe("player details before a court booking (website, as the app)", () => {
  it("asks only what is missing", () => {
    expect(missingForBooking({ name: "Rana", phone: "+96170123456" })).toEqual([]);
    expect(missingForBooking({ name: "Rana", phone: null })).toEqual(["phone"]);
    expect(missingForBooking({ name: "  ", phone: "+96170123456" })).toEqual(["name"]);
    expect(missingForBooking(null)).toEqual(["name", "phone"]);
  });
  it.each([
    ["03 123 456", "+9613123456"], ["70 123 456", "+96170123456"], ["+46 70 123 45 67", "+46701234567"], ["0046 70 123 45 67", "+46701234567"],
  ])("%s is accepted and saved as %s", (raw, saved) => {
    expect(checkDetails({ phone: raw }, ["phone"], true)).toEqual({});
    expect(detailsPatch({ phone: raw }, ["phone"])).toEqual({ phone: saved });
  });
  it("a Swedish local number without the country code is refused with the fix", () => {
    expect(checkDetails({ phone: "070 123 45 67" }, ["phone"], true).phone).toMatch(/start with \+ and the country code/);
  });
  it("required when booking, optional when editing; a long name is refused", () => {
    expect(checkDetails({ phone: "" }, ["phone"], true).phone).toBe("Enter a phone number the club can reach you on.");
    expect(checkDetails({ phone: "" }, ["phone"], false)).toEqual({});
    expect(detailsPatch({ phone: " " }, ["phone"])).toEqual({ phone: null });
    expect(checkDetails({ name: "x".repeat(81) }, ["name"], true).name).toMatch(/under 80/);
  });
  it("wording for failures and the reason line", () => {
    expect(saveProblem({ message: "account_closed" })).toMatch(/closed/);
    expect(saveProblem({ message: "Failed to fetch" })).toMatch(/connection/);
    expect(whyWeAsk(["phone"])).toBe("The club needs a number to reach you about this booking. We ask once.");
  });
  it("the details step returns to the exact selection", () => {
    expect(detailsPath("/club/batroun?at=2026-12-01T16:00:00.000Z&court=k1&dur=60")).toBe("/details?next=%2Fclub%2Fbatroun%3Fat%3D2026-12-01T16%3A00%3A00.000Z%26court%3Dk1%26dur%3D60");
  });
  // The app (#70) holds the same rules in mobile/lib/myProfile.ts, mobile/app/my-details.tsx and the club screen. On a tree that has
  // both (the pilot integration), every sentence a player reads must be identical on the website and in the app.
  const files = ["../../mobile/lib/myProfile.ts", "../../mobile/app/my-details.tsx", "../../mobile/app/club/[id].tsx"].map((f) => resolve(__dirname, f));
  it.skipIf(!files.every((f) => existsSync(f) && readFileSync(f, "utf8").length > 0) || !existsSync(files[0]))("same words as the app (needs #70 in the tree)", () => {
    const a = files.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const s of [PHONE_HELP, PHONE_PRIVACY, whyWeAsk(["name", "phone"]), whyWeAsk(["name"]), whyWeAsk(["phone"]),
      "Enter your name, as the club should see it.", "Enter a phone number the club can reach you on.",
      "That doesn't look like a full phone number. For a number outside Lebanon, start with + and the country code.",
      "This account is closed, so its details can't be changed.", "Not saved. Check your connection and try again.", UNREADABLE]) {
      expect(a.includes(s) || a.includes(s.replace("'", "\\'")), s).toBe(true);
    }
  });
});
