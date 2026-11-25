#!/usr/bin/env node
// Release gate: which icon and splash artwork a native build of each app would ship.
//   node scripts/check-store-artwork.mjs --app live      (fails while live uses the Expo template artwork)
//   node scripts/check-store-artwork.mjs --app staging   (fails unless staging uses its own STAGING artwork)
// Reads the resolved app config (app.json + app.config.ts) for the chosen app, hashes every icon and
// splash file it names, and compares them with the Expo template files created by the scaffold (1d014d0).
// Decision 25 Nov: no final store release may contain the Expo placeholder; the final icon comes from a
// separate branding decision. Development assets stay unchanged until then, so `--app live` fails today
// by design.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// sha256 of the Expo template files committed by the scaffold (git show 1d014d0:mobile/assets/<name>)
export const EXPO_PLACEHOLDERS = new Map([
  ["119462bb78eb240a65c869fc067ee599639b3cb5a41953f25c07b17d2a8c7e0f", "icon.png"],
  ["9e3d0315a33c6799de601dd34cd8bf8cc3a8d16f3bf75592baec2ceb7240b391", "android-icon-foreground.png"],
  ["fb139c2dee362ebf2070e23b96da6fc0d43f8492de38b8af1fd7223e19b5861d", "android-icon-background.png"],
  ["6371fc2c12e33ad2215a86c281db3d682a81bebe7c957a842c13b8bf00cceb83", "android-icon-monochrome.png"],
  ["5f4c0a732b6325bf4071d9124d2ae67e037cb24fcc9c482ef82bea742109a3b8", "splash-icon.png"],
  ["a4e030697a7571b3e95d31860e4da55d2f98e5e861e2b55e414f45a8556828ba", "favicon.png"],
]);

/** Every artwork file a resolved Expo config names, as [label, relative path]. */
export function artworkOf(config) {
  const out = [];
  if (config.icon) out.push(["icon", config.icon]);
  if (config.ios?.icon) out.push(["ios.icon", typeof config.ios.icon === "string" ? config.ios.icon : config.ios.icon.light]);
  const a = config.android?.adaptiveIcon ?? {};
  for (const k of ["foregroundImage", "backgroundImage", "monochromeImage"]) if (a[k]) out.push([`android.adaptiveIcon.${k}`, a[k]]);
  if (config.android?.icon) out.push(["android.icon", config.android.icon]);
  if (config.splash?.image) out.push(["splash.image", config.splash.image]);
  for (const p of config.plugins ?? []) {
    if (Array.isArray(p) && p[0] === "expo-splash-screen" && p[1]?.image) out.push(["expo-splash-screen.image", p[1].image]);
  }
  return out;
}

/** Problems for one app, given its artwork list and a hash function. Empty means it passes. */
export function problems(app, artwork, hashOf) {
  const found = [];
  if (artwork.length === 0) found.push("the config names no icon at all");
  for (const [label, path] of artwork) {
    const h = hashOf(path);
    if (EXPO_PLACEHOLDERS.has(h)) found.push(`${label} (${path}) is the Expo template ${EXPO_PLACEHOLDERS.get(h)}`);
    if (app === "staging" && !path.replace(/^\.\//, "").startsWith("assets/staging/"))
      found.push(`${label} (${path}) is not STAGING artwork (expected assets/staging/…)`);
  }
  return found;
}

function main() {
  const i = process.argv.indexOf("--app");
  const app = i > 0 ? process.argv[i + 1] : "";
  if (app !== "live" && app !== "staging") {
    console.error("usage: check-store-artwork.mjs --app live|staging");
    process.exit(2);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env };
  if (app === "staging") env.APP_VARIANT = "staging";
  else delete env.APP_VARIANT;
  const config = JSON.parse(
    execFileSync("npx", ["expo", "config", "--json", "--type", "public"], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  );
  const hashOf = (p) => createHash("sha256").update(readFileSync(resolve(root, p))).digest("hex");
  const art = artworkOf(config);
  for (const [label, path] of art) console.log(`${app}: ${label} = ${path}`);
  const found = problems(app, art, hashOf);
  if (found.length === 0) {
    console.log(`PASS ${app}: no Expo template artwork${app === "staging" ? "; all artwork is STAGING artwork" : ""}`);
    return;
  }
  for (const f of found) console.log(`FAIL ${app}: ${f}`);
  if (app === "live") console.log("The live app cannot go to a store until the final icon is approved and added (separate branding decision).");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
