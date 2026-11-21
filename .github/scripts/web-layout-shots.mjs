// Phase I: screenshots of the public (signed-out) website pages, before (BASE_URL) and after (HEAD_URL).
// At phone width (390 px) the two must be pixel-identical; at 768, 1280 and 1440 px the "after" shots
// (and "before" at 1280) are saved for review. Reads only; signs nobody in.
//   node web-layout-shots.mjs <outDir>   (BASE_URL, HEAD_URL set)
import puppeteer from "puppeteer";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] ?? "shots";
mkdirSync(out, { recursive: true });
const BASE = process.env.BASE_URL, HEAD = process.env.HEAD_URL;

const browser = await puppeteer.launch({ args: ["--no-sandbox", "--font-render-hinting=none"] });
const page = await browser.newPage();

async function shot(url, width, height) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
  await new Promise((r) => setTimeout(r, 300));
  return page.screenshot({ fullPage: true });
}

// The first club on the Courts page gives the club pages to check.
await page.goto(`${HEAD}/courts`, { waitUntil: "networkidle0", timeout: 60000 });
const club = await page.evaluate(() => (document.querySelector('a[href^="/club/"]')?.getAttribute("href") ?? "").split("?")[0].split("/")[2] ?? "");
const paths = ["/", "/courts", "/play", "/coaches", "/levels", "/login",
  ...(club ? [`/club/${club}`, `/club/${club}/info`, `/club/${club}/matches`, `/club/${club}/coaches`] : [])];
console.log(`club used: ${club || "(none found)"}`);

let failures = 0;
const name = (p) => (p === "/" ? "home" : p.slice(1).replace(/\//g, "_"));
for (const p of paths) {
  const a = PNG.sync.read(await shot(BASE + p, 390, 844));
  const b = PNG.sync.read(await shot(HEAD + p, 390, 844));
  let diff = -1;
  if (a.width === b.width && a.height === b.height) {
    const d = new PNG({ width: a.width, height: a.height });
    diff = pixelmatch(a.data, b.data, d.data, a.width, a.height, { threshold: 0 });
    if (diff) writeFileSync(`${out}/DIFF-390-${name(p)}.png`, PNG.sync.write(d));
  }
  const ok = diff === 0;
  if (!ok) { failures++; writeFileSync(`${out}/before-390-${name(p)}.png`, PNG.sync.write(a)); writeFileSync(`${out}/after-390-${name(p)}.png`, PNG.sync.write(b)); }
  console.log(`${ok ? "ok  " : "FAIL"}  390 px ${p}: ${diff === -1 ? `size differs (${a.width}×${a.height} → ${b.width}×${b.height})` : `${diff} pixels differ`}`);
  for (const w of [768, 1280, 1440]) writeFileSync(`${out}/after-${w}-${name(p)}.png`, await shot(HEAD + p, w, 900));
  writeFileSync(`${out}/before-1280-${name(p)}.png`, await shot(BASE + p, 1280, 900));
}
await browser.close();
console.log(failures ? `RESULT: ${failures} page(s) changed at phone width` : "RESULT: phone width identical on every page");
process.exit(failures ? 1 : 0);
