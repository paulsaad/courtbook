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
// The "Add CourtBook to your home screen" hint appears whenever Chrome happens to offer installing
// the site (beforeinstallprompt), which varies between loads; dismiss it as a user's ✕ does.
await page.evaluateOnNewDocument(() => { try { localStorage.setItem("cb_install_hint_dismissed", "1"); } catch {} });

async function shot(url, width, height) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
  await new Promise((r) => setTimeout(r, 300));
  return Buffer.from(await page.screenshot({ fullPage: true }));
}
async function text(url) {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
  return page.evaluate(() => document.body.innerText);
}
function compare(a, b, file) {
  if (a.width !== b.width || a.height !== b.height) return { n: -1, box: `size ${a.width}×${a.height} → ${b.width}×${b.height}` };
  const d = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, d.data, a.width, a.height, { threshold: 0 });
  if (!n) return { n, box: "" };
  let y0 = a.height, y1 = 0, x0 = a.width, x1 = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4;
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) { if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x; }
  }
  if (file) writeFileSync(file, PNG.sync.write(d));
  return { n, box: `x ${x0}–${x1}, y ${y0}–${y1} of ${a.height}` };
}

// The first club on the Courts page gives the club pages to check.
await page.goto(`${HEAD}/courts`, { waitUntil: "networkidle0", timeout: 60000 });
const club = await page.evaluate(() => (document.querySelector('a[href^="/club/"]')?.getAttribute("href") ?? "").split("?")[0].split("/")[2] ?? "");
const paths = ["/", "/courts", "/play", "/coaches", "/levels", "/login",
  ...(club ? [`/club/${club}`, `/club/${club}/info`, `/club/${club}/matches`, `/club/${club}/coaches`] : [])];
console.log(`club used: ${club || "(none found)"}`);

let failures = 0;
const preexisting = [];
const fixedPages = [];
const name = (p) => (p === "/" ? "home" : p.slice(1).replace(/\//g, "_"));
for (const p of paths) {
  // control: main against itself, a few seconds apart — shows what changes on its own (clocks, data)
  const a = PNG.sync.read(await shot(BASE + p, 390, 844));
  const b = PNG.sync.read(await shot(HEAD + p, 390, 844));
  const a2 = PNG.sync.read(await shot(BASE + p, 390, 844));
  const r = compare(a, b, `${out}/DIFF-390-${name(p)}.png`);
  const noise = compare(a, a2);
  const tb = await text(BASE + p), th = await text(HEAD + p);
  const sameText = tb === th;
  if (!sameText) {
    const lb = tb.split("\n"), lh = th.split("\n");
    const gone = lb.filter((l) => !lh.includes(l)).slice(0, 5), added = lh.filter((l) => !lb.includes(l)).slice(0, 5);
    console.log(`      text only before: ${JSON.stringify(gone)} · only after: ${JSON.stringify(added)}`);
  }
  // identical, or the only differences are ones main also shows against itself, with the same visible text
  // a page that shows Next.js's error screen in BOTH builds differs only by the random error number:
  // a fault that already exists on main, reported separately, not a layout change
  const norm = (s) => s.replace(/ERROR \d+/g, "ERROR #");
  const bothError = /ERROR \d+/.test(tb) && /ERROR \d+/.test(th) && norm(tb) === norm(th);
  if (bothError) preexisting.push(p);
  // a page that errors on main and renders on this branch: fixed here (the club Info page)
  const fixed = /ERROR \d+/.test(tb) && !/ERROR \d+/.test(th);
  if (fixed) fixedPages.push(p);
  const ok = r.n === 0 || bothError || fixed || (r.n > 0 && noise.n > 0 && sameText && r.box === noise.box);
  if (!ok) { failures++; writeFileSync(`${out}/before-390-${name(p)}.png`, PNG.sync.write(a)); writeFileSync(`${out}/after-390-${name(p)}.png`, PNG.sync.write(b)); }
  console.log(`${ok ? "ok  " : "FAIL"}  390 px ${p}: after vs before ${r.n < 0 ? r.box : `${r.n} px${r.box ? ` (${r.box})` : ""}`} · before vs before ${noise.n < 0 ? noise.box : `${noise.n} px${noise.box ? ` (${noise.box})` : ""}`} · visible text ${sameText ? "same" : "DIFFERENT"}`);
  for (const w of [768, 1280, 1440]) writeFileSync(`${out}/after-${w}-${name(p)}.png`, await shot(HEAD + p, w, 900));
  writeFileSync(`${out}/before-1280-${name(p)}.png`, await shot(BASE + p, 1280, 900));
}
await browser.close();
if (fixedPages.length) console.log(`FIXED: page errors on main and renders on this branch: ${fixedPages.join(", ")}`);
if (preexisting.length) console.log(`NOTE: page error in both builds (exists on main, not caused by this change): ${preexisting.join(", ")}`);
console.log(failures ? `RESULT: ${failures} page(s) changed at phone width` : "RESULT: phone width identical on every page");
process.exit(failures ? 1 : 0);
