import { hhmm, todayIn } from "@shared/time";

// Proves the web app's own logic files load in the app's test runner unchanged.
describe("shared src/lib", () => {
  it("formats in the club's timezone, not the phone's", () => {
    expect(hhmm("2026-11-14T16:30:00Z", "Asia/Beirut")).toBe("18:30");
  });
  it("gives today's date in the club's timezone", () => {
    expect(todayIn("Asia/Beirut")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
