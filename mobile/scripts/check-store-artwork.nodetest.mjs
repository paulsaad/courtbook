// node --test scripts/check-store-artwork.nodetest.mjs   (run from mobile/; named so Jest does not pick it up)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EXPO_PLACEHOLDERS, artworkOf, colorsOf, problems } from "./check-store-artwork.mjs";

const hashOf = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const approvals = JSON.parse(readFileSync("assets/artwork-approvals.json", "utf8"));
const app = JSON.parse(readFileSync("app.json", "utf8")).expo;
const stagingConfig = {
  icon: "./assets/staging/icon.png",
  android: { adaptiveIcon: {
    backgroundColor: "#1F2328",
    foregroundImage: "./assets/staging/android-icon-foreground.png",
    backgroundImage: "./assets/staging/android-icon-background.png",
    monochromeImage: "./assets/staging/android-icon-monochrome.png" } },
  plugins: [["expo-splash-screen", { image: "./assets/staging/splash-icon.png", backgroundColor: "#1F2328" }]],
};
const approve = (entry) => ({ ...entry, status: "approved", approvedBy: "Paul", approvedOn: "2026-11-26" });

test("today's live app fails: Expo template artwork, not in the approved list, not approved", () => {
  const p = problems("live", artworkOf(app), colorsOf(app), hashOf, approvals);
  for (const f of ["icon.png", "android-icon-foreground.png", "android-icon-background.png", "android-icon-monochrome.png", "splash-icon.png"])
    assert.ok(p.some((x) => x.includes(`Expo template ${f}`)), f);
  assert.ok(p.includes("the live artwork is not approved (status: not_approved)"));
});

test("live artwork that merely differs from the placeholder is NOT approved (decision 25 Nov)", () => {
  const p = problems("live", [["icon", "./assets/final.png"]], {}, () => "0".repeat(64), approvals);
  assert.ok(p.includes("icon (./assets/final.png) is not in the approved artwork list"));
  assert.ok(p.includes("the live artwork is not approved (status: not_approved)"));
});

test("the STG staging artwork matches its pinned hashes exactly, but stays refused while pending review", () => {
  const art = artworkOf(stagingConfig);
  assert.equal(art.length, 5);
  assert.deepEqual(problems("staging", art, colorsOf(stagingConfig), hashOf, approvals),
    ["the staging artwork is not approved (status: pending_review)"]);
});

test("once approved (a reviewed change), exactly that artwork passes", () => {
  const ok = { ...approvals, staging: approve(approvals.staging) };
  assert.deepEqual(problems("staging", artworkOf(stagingConfig), colorsOf(stagingConfig), hashOf, ok), []);
});

test("a different image under assets/staging/ fails even when approved: the folder proves nothing about the design", () => {
  const ok = { ...approvals, staging: approve(approvals.staging) };
  const tampered = (p) => (p === "./assets/staging/icon.png" ? "f".repeat(64) : hashOf(p));
  const p = problems("staging", artworkOf(stagingConfig), colorsOf(stagingConfig), tampered, ok);
  assert.equal(p.length, 1);
  assert.match(p[0], /^icon \(\.\/assets\/staging\/icon\.png\) differs from the approved artwork/);
});

test("a changed background colour fails", () => {
  const ok = { ...approvals, staging: approve(approvals.staging) };
  const p = problems("staging", artworkOf(stagingConfig), { ...colorsOf(stagingConfig), splashBackground: "#FFC400" }, hashOf, ok);
  assert.deepEqual(p, ["colour splashBackground #FFC400 is not the approved #1F2328"]);
});

test("staging that falls back to a live file fails, and so does an approval without approver or date", () => {
  const p = problems("staging", [["splash", "./assets/other.png"]], {}, () => "x", approvals);
  assert.ok(p.includes("splash (./assets/other.png) is not staging artwork (expected assets/staging/…)"));
  for (const half of [{ approvedBy: null }, { approvedOn: "tomorrow" }]) {
    const a = { ...approvals, staging: { ...approve(approvals.staging), ...half } };
    assert.ok(problems("staging", artworkOf(stagingConfig), colorsOf(stagingConfig), hashOf, a).some((x) => x.startsWith("the staging artwork is not approved")));
  }
});

test("a config with no icon fails", () => {
  assert.ok(problems("live", artworkOf({ plugins: ["expo-router"] }), {}, hashOf, approvals).includes("the config names no icon at all"));
});

test("the placeholder list matches the template files still in the repo", () => {
  for (const [h, name] of EXPO_PLACEHOLDERS) assert.equal(hashOf(`assets/${name}`), h, name);
});
