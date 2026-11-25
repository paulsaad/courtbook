#!/usr/bin/env node
// Release gate: is the icon and splash artwork a native build of this app would ship the APPROVED artwork?
//   node scripts/check-store-artwork.mjs --app live
//   node scripts/check-store-artwork.mjs --app staging
// Reads the resolved app config (app.json + app.config.ts) for the chosen app and hashes every icon and splash file
// it names. It passes only if:
//   1. no file is an Expo template file (hashes from the scaffold, 1d014d0);
//   2. staging uses only files under assets/staging/ (live/staging separation);
//   3. every file and colour matches assets/artwork-approvals.json for that app, byte for byte (sha256), and
//   4. that app's entry is "approved", with approvedBy and approvedOn.
// A folder name or "not the placeholder" proves nothing about the design; only 3 and 4 tie a build to the exact
// artwork Paul approved. Decisions 25 Nov:
//   - no store release may contain the Expo placeholder;
//   - the final icon comes from a separate branding decision, and passing this gate for live is NOT branding
//     approval by itself: the live entry is filled in only after that decision;
//   - the staging "STG" artwork needed Paul's approval before any native build: approved 25 Nov 2026 (artwork only;
//     not authorization to merge or build).
// Today live fails by design ("not_approved"); staging passes with exactly the approved files.
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

const norm = (p) => "./" + String(p).replace(/^\.\//, "");

/** Every artwork file a resolved Expo config names, as [label, "./relative/path"]. */
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
  return out.map(([l, p]) => [l, norm(p)]);
}

/** The colours shown around the artwork (adaptive-icon background, splash background). */
export function colorsOf(config) {
  const c = {};
  if (config.android?.adaptiveIcon?.backgroundColor) c.adaptiveIconBackground = config.android.adaptiveIcon.backgroundColor;
  for (const p of config.plugins ?? []) {
    if (Array.isArray(p) && p[0] === "expo-splash-screen" && p[1]?.backgroundColor) c.splashBackground = p[1].backgroundColor;
  }
  return c;
}

/** Problems for one app. Empty means it passes. */
export function problems(app, artwork, colors, hashOf, approvals) {
  const found = [];
  if (artwork.length === 0) found.push("the config names no icon at all");
  const entry = approvals?.[app];
  for (const [label, path] of artwork) {
    const h = hashOf(path);
    if (EXPO_PLACEHOLDERS.has(h)) found.push(`${label} (${path}) is the Expo template ${EXPO_PLACEHOLDERS.get(h)}`);
    if (app === "staging" && !path.startsWith("./assets/staging/")) found.push(`${label} (${path}) is not staging artwork (expected assets/staging/…)`);
    const want = entry?.files?.[path];
    if (!want) found.push(`${label} (${path}) is not in the approved artwork list`);
    else if (want !== h) found.push(`${label} (${path}) differs from the approved artwork (sha256 ${h.slice(0, 12)}…, approved ${want.slice(0, 12)}…)`);
  }
  for (const [k, v] of Object.entries(colors)) {
    const want = entry?.colors?.[k];
    if (!want || want.toUpperCase() !== String(v).toUpperCase()) found.push(`colour ${k} ${v} is not the approved ${want ?? "(none)"}`);
  }
  const approved = entry?.status === "approved" && typeof entry.approvedBy === "string" && entry.approvedBy.trim()
    && /^\d{4}-\d{2}-\d{2}$/.test(entry.approvedOn ?? "");
  if (!approved) found.push(`the ${app} artwork is not approved (status: ${entry?.status ?? "missing"})`);
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
  const approvals = JSON.parse(readFileSync(resolve(root, "assets/artwork-approvals.json"), "utf8"));
  const hashOf = (p) => createHash("sha256").update(readFileSync(resolve(root, p))).digest("hex");
  const art = artworkOf(config);
  for (const [label, path] of art) console.log(`${app}: ${label} = ${path}`);
  const found = problems(app, art, colorsOf(config), hashOf, approvals);
  if (found.length === 0) {
    console.log(`PASS ${app}: every icon and splash file is the approved artwork (approved by ${approvals[app].approvedBy}, ${approvals[app].approvedOn})`);
    return;
  }
  for (const f of found) console.log(`FAIL ${app}: ${f}`);
  if (app === "live") console.log("The live app cannot go to a store until its final artwork is approved after the branding decision.");
  else console.log("The staging app cannot be built until Paul approves this exact artwork (assets/artwork-approvals.json).");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
