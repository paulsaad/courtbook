/**
 * One illustration for the fictional demo club, and a crest.
 *
 * The first attempt produced five schematic court diagrams — accurate geometry, no warmth, and three
 * of them pretending to be a photo gallery. A booking app's cover has to make someone want to play,
 * not show them a plan view. This replaces all of that with a single evening scene: the
 * Mediterranean behind, low sun, glass walls catching the light, two figures mid-point.
 *
 * It is an illustration and does not pretend otherwise. The demo label is a badge you can read at
 * thumbnail size, not small print.
 *
 * The crest stays flat and geometric on purpose — that is what a crest is, which is not the same
 * mistake as drawing a diagram and calling it a photograph.
 *
 *   node scripts/demo-images.mjs
 */
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";

const INK = "#121614", TURF = "#0f7a47", DEEP = "#0a5c36", SOFT = "#e3f3ea", SAND = "#8a6a1f", PAPER = "#f6f6f4";

/** A badge, sized to stay legible when the cover is shown ~350px wide in a listing. */
const badge = (w, h, s = 1) => `
  <g>
    <rect x="${28 * s}" y="${h - 80 * s}" width="${286 * s}" height="${52 * s}" rx="${26 * s}"
          fill="#ffffff" opacity="0.95"/>
    <circle cx="${56 * s}" cy="${h - 54 * s}" r="${11 * s}" fill="${SAND}"/>
    <text x="${76 * s}" y="${h - 57 * s}" font-family="system-ui,-apple-system,Segoe UI,sans-serif"
          font-size="${15.5 * s}" font-weight="700" fill="${INK}" letter-spacing="0.4">FICTIONAL DEMO CLUB</text>
    <text x="${76 * s}" y="${h - 39 * s}" font-family="system-ui,-apple-system,Segoe UI,sans-serif"
          font-size="${12.5 * s}" fill="#4a5450">Illustration · not a real venue</text>
  </g>`;

/** A figure mid-point. Silhouettes give the court a scale that nothing else does. */
const player = (x, y, s, flip, colour) => `
  <g transform="translate(${x},${y}) scale(${flip ? -s : s},${s})" fill="${colour}">
    <circle cx="0" cy="-34" r="6.4"/>
    <path d="M-5,-27 L5,-27 L8,-8 L4,-8 L3,-15 L-3,-15 L-4,-8 L-8,-8 Z"/>
    <path d="M-4,-8 L-2,10 L-6,10 L-9,-7 Z"/>
    <path d="M4,-8 L9,9 L5,11 L0,-7 Z"/>
    <path d="M5,-25 L19,-33 L21,-29 L7,-20 Z"/>
    <ellipse cx="25" cy="-36" rx="7" ry="9" transform="rotate(-24 25 -36)"/>
  </g>`;

const cover = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600" viewBox="0 0 1600 600">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"    stop-color="#1b3a5c"/>
      <stop offset="0.42" stop-color="#6f7f8e"/>
      <stop offset="0.66" stop-color="#d8a05e"/>
      <stop offset="0.82" stop-color="#f2c98a"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.63" cy="0.72" r="0.42">
      <stop offset="0" stop-color="#ffe6b0" stop-opacity="0.95"/>
      <stop offset="1" stop-color="#ffd089" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2d5b74"/><stop offset="1" stop-color="#17374a"/>
    </linearGradient>
    <linearGradient id="floor" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#1a9a63"/><stop offset="0.55" stop-color="#0f7a47"/><stop offset="1" stop-color="#0a5c36"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#bfe6d2" stop-opacity="0.07"/>
    </linearGradient>
    <linearGradient id="warm" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffcf8a" stop-opacity="0"/>
      <stop offset="0.55" stop-color="#ffcf8a" stop-opacity="0.5"/>
      <stop offset="1" stop-color="#ffcf8a" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="1600" height="600" fill="url(#sky)"/>
  <ellipse cx="1010" cy="432" rx="620" ry="260" fill="url(#sun)"/>

  <path d="M0,404 L150,372 L330,390 L470,362 L650,394 L780,378 L900,398 L1050,376 L1230,396 L1420,370 L1600,392 L1600,424 L0,424 Z"
        fill="#3b4a5a" opacity="0.55"/>
  <rect y="422" width="1600" height="46" fill="url(#sea)"/>
  <ellipse cx="1010" cy="436" rx="150" ry="7" fill="#ffd79a" opacity="0.3"/>
  <rect y="466" width="1600" height="16" fill="#9a8a6d" opacity="0.55"/>
  <rect y="480" width="1600" height="14" fill="#2a3a33"/>

  <polygon points="214,588 1386,588 1146,470 452,470" fill="url(#floor)"/>
  <polygon points="214,588 1386,588 1146,470 452,470" fill="url(#warm)" opacity="0.55"/>
  ${[0.3, 0.62].map((t) => {
    const y = 588 - t * 118, l = 214 + t * 238, r = 1386 - t * 240;
    return `<line x1="${l.toFixed(0)}" y1="${y.toFixed(0)}" x2="${r.toFixed(0)}" y2="${y.toFixed(0)}" stroke="#eaf5ee" stroke-width="${(3 - t * 1.2).toFixed(1)}" opacity="0.8"/>`;
  }).join("")}
  <line x1="800" y1="517" x2="800" y2="588" stroke="#eaf5ee" stroke-width="2.6" opacity="0.8"/>
  <polygon points="214,588 1386,588 1146,470 452,470" fill="none" stroke="#eaf5ee" stroke-width="3.4" opacity="0.9"/>

  <polygon points="452,470 1146,470 1146,386 452,386" fill="url(#glass)"/>
  <line x1="452" y1="386" x2="1146" y2="386" stroke="#eaf5ee" stroke-width="3" opacity="0.75"/>
  <line x1="452" y1="386" x2="452" y2="470" stroke="#eaf5ee" stroke-width="3" opacity="0.6"/>
  <line x1="1146" y1="386" x2="1146" y2="470" stroke="#eaf5ee" stroke-width="3" opacity="0.6"/>
  <line x1="799" y1="386" x2="799" y2="470" stroke="#eaf5ee" stroke-width="1.6" opacity="0.3"/>

  <g>
    ${Array.from({ length: 48 }, (_, i) => {
      const x = 348 + (i * 904) / 47;
      return `<line x1="${x.toFixed(1)}" y1="${518}" x2="${x.toFixed(1)}" y2="${535}" stroke="#0b2a1c" stroke-width="1" opacity="0.3"/>`;
    }).join("")}
    <line x1="348" y1="535" x2="1252" y2="535" stroke="#0b2a1c" stroke-width="3" opacity="0.8"/>
    <line x1="348" y1="518" x2="1252" y2="518" stroke="#f2f8f4" stroke-width="2.6" opacity="0.95"/>
    <line x1="348" y1="514" x2="348" y2="538" stroke="#eaf5ee" stroke-width="4"/>
    <line x1="1252" y1="514" x2="1252" y2="538" stroke="#eaf5ee" stroke-width="4"/>
  </g>

  ${[[398, 470], [1200, 470]].map(([x, y]) => `
    <line x1="${x}" y1="${y}" x2="${x}" y2="188" stroke="#16211c" stroke-width="7"/>
    <rect x="${x - 36}" y="168" width="72" height="22" rx="7" fill="#1d2a24"/>
    <ellipse cx="${x}" cy="196" rx="54" ry="30" fill="#ffe3ad" opacity="0.26"/>
    <circle cx="${x - 20}" cy="179" r="7" fill="#ffeec4"/>
    <circle cx="${x}" cy="179" r="7" fill="#ffeec4"/>
    <circle cx="${x + 20}" cy="179" r="7" fill="#ffeec4"/>`).join("")}

  <ellipse cx="600" cy="578" rx="80" ry="10" fill="#06301f" opacity="0.4"/>
  <ellipse cx="1030" cy="558" rx="70" ry="9" fill="#06301f" opacity="0.36"/>
  ${player(600, 576, 1.9, false, "#10281e")}
  ${player(1030, 556, 1.6, true, "#102a20")}
  <circle cx="838" cy="496" r="9" fill="#e8ec6a"/>
  <circle cx="838" cy="496" r="9" fill="none" stroke="#b9bd45" stroke-width="1.4"/>

  <g fill="#0d2419" opacity="0.92">
    <path d="M-10,600 C60,540 120,520 190,512 C120,536 70,568 40,600 Z"/>
    <path d="M-10,600 C40,520 96,474 170,446 C110,494 62,546 36,600 Z"/>
    <path d="M1610,600 C1540,544 1486,524 1420,514 C1486,540 1534,570 1564,600 Z"/>
  </g>

  ${badge(1600, 600)}
</svg>`;

/** The club crest. Flat and geometric on purpose. */
const logo = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs>
    <linearGradient id="disc" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${SOFT}"/><stop offset="1" stop-color="#cdeadb"/>
    </linearGradient>
    <clipPath id="face"><ellipse cx="200" cy="170" rx="78" ry="92"/></clipPath>
  </defs>
  <rect width="400" height="400" fill="${PAPER}"/>
  <circle cx="200" cy="200" r="152" fill="url(#disc)"/>
  <g clip-path="url(#face)">
    ${Array.from({ length: 7 }, (_, i) => `<line x1="${130 + i * 24}" y1="70" x2="${130 + i * 24}" y2="270" stroke="${TURF}" stroke-width="3.2" opacity="0.4"/>`).join("")}
    ${Array.from({ length: 7 }, (_, i) => `<line x1="114" y1="${94 + i * 26}" x2="286" y2="${94 + i * 26}" stroke="${TURF}" stroke-width="3.2" opacity="0.4"/>`).join("")}
  </g>
  <ellipse cx="200" cy="170" rx="78" ry="92" fill="none" stroke="${DEEP}" stroke-width="13"/>
  <rect x="190" y="258" width="20" height="66" rx="10" fill="${INK}"/>
  <circle cx="288" cy="250" r="19" fill="${SAND}"/>
</svg>`;

await mkdir("demo-images", { recursive: true });
for (const [name, svg, w, h] of [["cover.webp", cover(), 1600, 600], ["logo.webp", logo(), 400, 400]]) {
  const out = await sharp(Buffer.from(svg)).resize(w, h).webp({ quality: 90 }).toBuffer();
  await writeFile(`demo-images/${name}`, out);
  console.log(`${name}  ${w}×${h}  ${(out.byteLength / 1024).toFixed(0)} kB`);
}
console.log("\nNo gallery images: three court diagrams pretending to be photographs was the mistake.");
