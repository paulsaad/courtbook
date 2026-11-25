// node --test scripts/check-store-artwork.nodetest.mjs   (run from mobile/; named so Jest does not pick it up)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EXPO_PLACEHOLDERS, artworkOf, problems } from "./check-store-artwork.mjs";

const hashOf = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const app = JSON.parse(readFileSync("app.json", "utf8")).expo;

test("today's live config names the Expo template artwork, so the live gate fails", () => {
  const p = problems("live", artworkOf(app), hashOf);
  for (const f of ["icon.png", "android-icon-foreground.png", "android-icon-background.png", "android-icon-monochrome.png", "splash-icon.png"])
    assert.ok(p.some((x) => x.includes(`Expo template ${f}`)), f);
});

test("the STAGING artwork is not a placeholder and lives under assets/staging", () => {
  const staging = {
    icon: "./assets/staging/icon.png",
    android: { adaptiveIcon: {
      foregroundImage: "./assets/staging/android-icon-foreground.png",
      backgroundImage: "./assets/staging/android-icon-background.png",
      monochromeImage: "./assets/staging/android-icon-monochrome.png" } },
    plugins: [["expo-splash-screen", { image: "./assets/staging/splash-icon.png" }]],
  };
  assert.equal(artworkOf(staging).length, 5);
  assert.deepEqual(problems("staging", artworkOf(staging), hashOf), []);
});

test("staging that falls back to a live asset fails even if the asset is not a placeholder", () => {
  const p = problems("staging", [["icon", "./assets/staging/icon.png"], ["splash", "./assets/other.png"]], () => "x");
  assert.deepEqual(p, ["splash (./assets/other.png) is not STAGING artwork (expected assets/staging/…)"]);
});

test("a final live icon (any non-template file) passes the live gate", () => {
  assert.deepEqual(problems("live", [["icon", "./assets/final.png"]], () => "0".repeat(64)), []);
});

test("a config with no icon fails", () => {
  assert.deepEqual(problems("live", artworkOf({ plugins: ["expo-router"] }), hashOf), ["the config names no icon at all"]);
});

test("the placeholder list matches the template files still in the repo", () => {
  for (const [h, name] of EXPO_PLACEHOLDERS) assert.equal(hashOf(`assets/${name}`), h, name);
});
