/**
 * H2 (Session B's axe run, 26 Nov): text below WCAG AA (4.5:1 for small text). The pairs now used, computed with the
 * WCAG formula, and the old low-contrast classes gone from those files.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const css = readFileSync("src/app/globals.css", "utf8");
const token = (name: string) => css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`))![1];
const src = (f: string) => readFileSync(f, "utf8");

describe("text contrast (WCAG AA, small text ≥ 4.5:1)", () => {
  it("section labels (.eyebrow) and the Courts weekday use the muted token, readable on white and on paper", () => {
    expect(css).toMatch(/\.eyebrow \{[^}]*color: var\(--color-muted\)/);
    expect(ratio(token("muted"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("muted"), token("paper"))).toBeGreaterThanOrEqual(4.5);
    expect(src("src/app/courts/CourtsDay.tsx")).not.toContain("text-[#8a918e]");
    expect(ratio("#8a918e", "#ffffff")).toBeLessThan(4.5);   // why it went
  });
  it("Share on WhatsApp on a booking: ink on WhatsApp green (white was 2.0:1)", () => {
    expect(src("src/app/bookings/[id]/page.tsx")).toMatch(/bg-\[#25D366\][^"]*text-ink[^"]*">Share on WhatsApp/);
    expect(ratio(token("ink"), "#25d366")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("#ffffff", "#25d366")).toBeLessThan(4.5);
  });
  it("own chat messages: Delete and the time in full white on turf (white/80 and white/70 were 4.05 and 3.48)", () => {
    const chat = src("src/app/matches/[id]/MatchChat.tsx");
    expect(chat).not.toMatch(/text-white\/(70|80)/);
    expect(ratio("#ffffff", token("turf"))).toBeGreaterThanOrEqual(4.5);
  });
});
