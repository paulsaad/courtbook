import { cappedLineHeight } from "../components/Text";

// Android scales lineHeight by the full phone text size but caps the letters (TextAttributeProps.kt),
// so past the cap the line height is pre-shrunk to land where the cap puts the letters.
describe("cappedLineHeight", () => {
  it("Android past the cap: the line height lands at lineHeight × cap", () => {
    const r = cappedLineHeight(21, 2.0, 1.6, "android");
    expect(r!.lineHeight * 2.0).toBeCloseTo(21 * 1.6);
  });
  it("leaves everything else alone", () => {
    expect(cappedLineHeight(21, 1.3, 1.6, "android")).toBeNull();   // under the cap
    expect(cappedLineHeight(21, 1.6, 1.6, "android")).toBeNull();   // at the cap
    expect(cappedLineHeight(21, 2.0, 1.6, "ios")).toBeNull();       // iOS caps both already
    expect(cappedLineHeight(undefined, 2.0, 1.6, "android")).toBeNull();
    expect(cappedLineHeight(21, 2.0, 0, "android")).toBeNull();     // 0 = no cap
    expect(cappedLineHeight(21, 2.0, 1.6, "android", false)).toBeNull(); // not scaled at all
  });
});
