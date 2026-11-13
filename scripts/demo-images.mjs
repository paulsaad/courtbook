/**
 * Original abstract court graphics for the fictional demo club.
 *
 * These exist so a demo does not rest on photographs of a place that does not exist. They are drawn
 * here from scratch — court geometry, the app's own palette — and every one carries the words
 * "Illustrative image · fictional demo club" **inside the picture**. A caption can be edited away or
 * left behind when an image is reused somewhere that has no caption field; a label that is part of
 * the artwork travels with it.
 *
 *   node scripts/demo-images.mjs
 *
 * Writes WebP at the sizes the upload route produces, so re-encoding on upload changes nothing.
 */
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";

const PAPER = "#f6f6f4", INK = "#121614", TURF = "#0f7a47", DEEP = "#0a5c36", SOFT = "#e3f3ea", SAND = "#8a6a1f";
const LABEL = "Illustrative image · fictional demo club";

/** The label strip, bottom-left, legible on any of the backgrounds below. */
const label = (w, h, scale = 1) => `
  <g opacity="0.92">
    <rect x="${16 * scale}" y="${h - 40 * scale}" width="${LABEL.length * 7.1 * scale + 24 * scale}" height="${26 * scale}"
          rx="${13 * scale}" fill="${INK}" opacity="0.82"/>
    <text x="${28 * scale}" y="${h - 22 * scale}" font-family="system-ui, -apple-system, Segoe UI, sans-serif"
          font-size="${13 * scale}" fill="#ffffff" letter-spacing="0.2">${LABEL}</text>
  </g>`;

/**
 * A padel court seen from behind the near baseline. The geometry is worked out rather than eyeballed:
 * the court is a trapezoid from (300,560) to (1300,560) at the near edge and (470,150) to (1130,150)
 * at the far one, and anything drawn across it is interpolated along those edges so the net, the
 * service lines and the posts all sit at the right width for their depth.
 */
const edges = (y) => {
  const t = (560 - y) / 410;                  // 0 at the near edge, 1 at the far one
  return [300 + t * 170, 1300 - t * 170];
};
const across = (y, stroke, width, opacity = 1) => {
  const [l, r] = edges(y);
  return `<line x1="${l}" y1="${y}" x2="${r}" y2="${y}" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`;
};

const cover = () => {
  const netY = 360, [netL, netR] = edges(netY);
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600" viewBox="0 0 1600 600">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${SOFT}"/><stop offset="1" stop-color="${PAPER}"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="600" fill="url(#sky)"/>
  <polygon points="300,560 1300,560 1130,150 470,150" fill="${TURF}" opacity="0.14"/>
  <polygon points="300,560 1300,560 1130,150 470,150" fill="none" stroke="${DEEP}" stroke-width="4"/>
  ${across(250, DEEP, 2.5, 0.55)}
  ${across(470, DEEP, 3, 0.7)}
  <line x1="800" y1="150" x2="800" y2="250" stroke="${DEEP}" stroke-width="2" opacity="0.4"/>
  <line x1="800" y1="470" x2="800" y2="560" stroke="${DEEP}" stroke-width="3" opacity="0.7"/>
  <!-- the net, at mid-depth and exactly as wide as the court is there -->
  ${Array.from({ length: 44 }, (_, i) => {
    const x = netL + (i * (netR - netL)) / 43;
    return `<line x1="${x.toFixed(1)}" y1="${netY - 52}" x2="${x.toFixed(1)}" y2="${netY}" stroke="${INK}" stroke-width="1" opacity="0.3"/>`;
  }).join("")}
  <line x1="${netL}" y1="${netY - 52}" x2="${netR}" y2="${netY - 52}" stroke="${INK}" stroke-width="2.5" opacity="0.55"/>
  <line x1="${netL}" y1="${netY}" x2="${netR}" y2="${netY}" stroke="${INK}" stroke-width="5"/>
  <line x1="${netL}" y1="${netY - 56}" x2="${netL}" y2="${netY + 4}" stroke="${INK}" stroke-width="5"/>
  <line x1="${netR}" y1="${netY - 56}" x2="${netR}" y2="${netY + 4}" stroke="${INK}" stroke-width="5"/>
  <!-- floodlight masts, behind the far edge -->
  <line x1="470" y1="150" x2="470" y2="52" stroke="${INK}" stroke-width="5"/>
  <circle cx="470" cy="44" r="15" fill="${SAND}" opacity="0.9"/>
  <line x1="1130" y1="150" x2="1130" y2="52" stroke="${INK}" stroke-width="5"/>
  <circle cx="1130" cy="44" r="15" fill="${SAND}" opacity="0.9"/>
  <circle cx="985" cy="232" r="12" fill="${SAND}"/>
  ${label(1600, 600)}
</svg>`;
};

/** A club mark: an abstract racket face over a soft disc. Geometric, no lettering, strings clipped
 *  to the face so they do not spill past it. */
const logo = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs><clipPath id="face"><ellipse cx="200" cy="172" rx="80" ry="94"/></clipPath></defs>
  <rect width="400" height="400" fill="${PAPER}"/>
  <circle cx="200" cy="200" r="150" fill="${SOFT}"/>
  <g clip-path="url(#face)">
    ${Array.from({ length: 7 }, (_, i) => `<line x1="${128 + i * 24}" y1="72" x2="${128 + i * 24}" y2="272" stroke="${TURF}" stroke-width="3.5" opacity="0.45"/>`).join("")}
    ${Array.from({ length: 7 }, (_, i) => `<line x1="112" y1="${96 + i * 26}" x2="288" y2="${96 + i * 26}" stroke="${TURF}" stroke-width="3.5" opacity="0.45"/>`).join("")}
  </g>
  <ellipse cx="200" cy="172" rx="80" ry="94" fill="none" stroke="${DEEP}" stroke-width="12"/>
  <rect x="190" y="262" width="20" height="64" rx="10" fill="${INK}"/>
  <circle cx="286" cy="252" r="19" fill="${SAND}"/>
</svg>`;

/** Three looks at the same invented venue: from above, from the baseline, and at night. */
const galleryTop = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <rect width="1200" height="900" fill="${PAPER}"/>
  <rect x="150" y="120" width="900" height="660" fill="${TURF}" opacity="0.16"/>
  <rect x="150" y="120" width="900" height="660" fill="none" stroke="${DEEP}" stroke-width="5"/>
  <line x1="150" y1="450" x2="1050" y2="450" stroke="${INK}" stroke-width="6"/>
  <rect x="150" y="268" width="900" height="364" fill="none" stroke="${DEEP}" stroke-width="3" opacity="0.65"/>
  <line x1="600" y1="268" x2="600" y2="632" stroke="${DEEP}" stroke-width="3" opacity="0.65"/>
  <circle cx="420" cy="300" r="15" fill="${SAND}"/>
  ${label(1200, 900, 1.3)}
</svg>`;

const galleryBaseline = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <rect width="1200" height="900" fill="${SOFT}"/>
  <rect y="560" width="1200" height="340" fill="${TURF}" opacity="0.2"/>
  <polygon points="140,880 1060,880 870,560 330,560" fill="none" stroke="${DEEP}" stroke-width="5"/>
  <line x1="190" y1="790" x2="1010" y2="790" stroke="${DEEP}" stroke-width="3" opacity="0.6"/>
  <line x1="600" y1="790" x2="600" y2="880" stroke="${DEEP}" stroke-width="3" opacity="0.6"/>
  <line x1="300" y1="470" x2="900" y2="470" stroke="${INK}" stroke-width="6"/>
  <line x1="300" y1="470" x2="300" y2="590" stroke="${INK}" stroke-width="5"/>
  <line x1="900" y1="470" x2="900" y2="590" stroke="${INK}" stroke-width="5"/>
  ${Array.from({ length: 24 }, (_, i) => `<line x1="${300 + i * 26}" y1="470" x2="${300 + i * 26}" y2="545" stroke="${INK}" stroke-width="1.5" opacity="0.3"/>`).join("")}
  ${label(1200, 900, 1.3)}
</svg>`;

const galleryNight = () => `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.2" r="0.8">
      <stop offset="0" stop-color="${SAND}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${INK}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="900" fill="${INK}"/>
  <rect width="1200" height="900" fill="url(#glow)"/>
  <polygon points="180,820 1020,820 880,430 320,430" fill="${TURF}" opacity="0.3"/>
  <polygon points="180,820 1020,820 880,430 320,430" fill="none" stroke="${SOFT}" stroke-width="4" opacity="0.8"/>
  <line x1="224" y1="705" x2="976" y2="705" stroke="${SOFT}" stroke-width="2.5" opacity="0.5"/>
  <line x1="600" y1="705" x2="600" y2="820" stroke="${SOFT}" stroke-width="2.5" opacity="0.5"/>
  <!-- the net, mid-depth, as wide as the court is there -->
  ${Array.from({ length: 34 }, (_, i) => `<line x1="${(250 + (i * 700) / 33).toFixed(1)}" y1="585" x2="${(250 + (i * 700) / 33).toFixed(1)}" y2="625" stroke="${SOFT}" stroke-width="1" opacity="0.25"/>`).join("")}
  <line x1="250" y1="585" x2="950" y2="585" stroke="${SOFT}" stroke-width="2" opacity="0.45"/>
  <line x1="250" y1="625" x2="950" y2="625" stroke="${SOFT}" stroke-width="4" opacity="0.9"/>
  <line x1="250" y1="580" x2="250" y2="629" stroke="${SOFT}" stroke-width="4" opacity="0.9"/>
  <line x1="950" y1="580" x2="950" y2="629" stroke="${SOFT}" stroke-width="4" opacity="0.9"/>
  <line x1="320" y1="430" x2="320" y2="250" stroke="${SOFT}" stroke-width="5" opacity="0.7"/>
  <circle cx="320" cy="236" r="22" fill="${SAND}"/>
  <line x1="880" y1="430" x2="880" y2="250" stroke="${SOFT}" stroke-width="5" opacity="0.7"/>
  <circle cx="880" cy="236" r="22" fill="${SAND}"/>
  ${label(1200, 900, 1.3)}
</svg>`;

const files = [
  ["cover.webp", cover(), 1600, 600],
  ["logo.webp", logo(), 400, 400],
  ["court-from-above.webp", galleryTop(), 1200, 900],
  ["court-from-the-baseline.webp", galleryBaseline(), 1200, 900],
  ["court-under-floodlights.webp", galleryNight(), 1200, 900],
];

await mkdir("demo-images", { recursive: true });
for (const [name, svg, w, h] of files) {
  const out = await sharp(Buffer.from(svg)).resize(w, h).webp({ quality: 88 }).toBuffer();
  await writeFile(`demo-images/${name}`, out);
  console.log(`${name}  ${w}×${h}  ${(out.byteLength / 1024).toFixed(0)} kB`);
}
console.log(`\nEvery one carries "${LABEL}" inside the image.`);
