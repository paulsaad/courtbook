#!/usr/bin/env node
/**
 * M5 release sequencing (review, 23 Nov 2026): the app's legal links may only reach players after the official pages
 * are legally approved, published and publicly reachable. This checks the pages the app actually links to
 * (mobile/lib/legal.ts WEBSITE_URL and LEGAL_PAGES), over the public internet, with no sign-in:
 *   - HTTP 200 on the same https origin (no redirect to a login, no Vercel protection page);
 *   - the expected page (its title);
 *   - final: no draft notice, no marked unfinished wording (data-pending), a "Last updated" date;
 *   - indexable: no robots "noindex" (meta tag or X-Robots-Tag header).
 * It only reads. Usage:
 *   node scripts/check-legal-pages.mjs [--mode fail|warn] [--base https://…]
 * --mode warn prints GitHub warnings and exits 0 (staging builds); fail (default) exits 1 on any problem (live app).
 * --base overrides WEBSITE_URL (to check a domain before the constant is changed).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Each page the app links to, and the words its <title> must contain. */
export const EXPECTED_TITLE = { privacy: "Privacy policy", terms: "Terms of use", "delete-account": "Delete your CourtBook account" };

/** WEBSITE_URL and the page paths, read from the app's own source so the check follows any change there. */
export function readAppLinks(source) {
  const base = source.match(/export const WEBSITE_URL = "([^"]+)"/)?.[1];
  if (!base) throw new Error("WEBSITE_URL not found in mobile/lib/legal.ts");
  const pages = [...source.matchAll(/\{\s*key:\s*"([^"]+)"[^}]*url:\s*`\$\{WEBSITE_URL\}(\/[^`]*)`/g)].map((m) => ({ key: m[1], path: m[2] }));
  if (!pages.length) throw new Error("LEGAL_PAGES not found in mobile/lib/legal.ts");
  return { base, pages };
}

/** Problems with one fetched page (empty = ready). Pure, so it is tested on fixture pages. */
export function pageProblems({ url, finalUrl, status, headers, html, key }) {
  const p = [];
  if (!/^https:\/\//.test(url)) p.push("not https");
  if (status !== 200) p.push(`HTTP ${status}`);
  if (finalUrl && new URL(finalUrl).origin !== new URL(url).origin) p.push(`redirected to ${new URL(finalUrl).origin}`);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
  const want = EXPECTED_TITLE[key];
  if (!want) p.push(`no expected title known for "${key}" (add it to EXPECTED_TITLE)`);
  else if (!title.includes(want)) p.push(`title is "${title.slice(0, 60)}", expected "${want}"`);
  if (/data-pending=/.test(html)) p.push(`${(html.match(/data-pending=/g) ?? []).length} marked unfinished item(s) (data-pending)`);
  if (/Draft notice|Draft for review/i.test(html)) p.push("draft notice shown");
  if (!/Last updated:/.test(html)) p.push('no "Last updated" date');
  const robots = [...html.matchAll(/<meta[^>]+name=["']robots["'][^>]*>/gi)].map((m) => m[0]).join(" ");
  if (/noindex/i.test(robots)) p.push("robots meta says noindex");
  const xr = typeof headers?.get === "function" ? headers.get("x-robots-tag") : headers?.["x-robots-tag"];
  if (xr && /noindex/i.test(xr)) p.push("X-Robots-Tag says noindex");
  return p;
}

async function main(argv) {
  const mode = argv.includes("--mode") ? argv[argv.indexOf("--mode") + 1] : "fail";
  if (!["fail", "warn"].includes(mode)) throw new Error("--mode must be fail or warn");
  const here = dirname(fileURLToPath(import.meta.url));
  const { base: appBase, pages } = readAppLinks(readFileSync(join(here, "..", "lib", "legal.ts"), "utf8"));
  const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1].replace(/\/$/, "") : appBase;
  let bad = 0;
  for (const { key, path } of pages) {
    const url = base + path;
    let problems;
    try {
      const r = await fetch(url, { redirect: "follow", headers: { "user-agent": "CourtBook legal-pages check" } });
      problems = pageProblems({ url, finalUrl: r.url, status: r.status, headers: r.headers, html: await r.text(), key });
    } catch (e) {
      problems = [`not reachable (${e.cause?.code ?? e.message})`];
    }
    if (problems.length) bad++;
    console.log(`${problems.length ? "NOT READY" : "ready"}  ${url}${problems.length ? ": " + problems.join("; ") : ""}`);
  }
  const summary = bad
    ? `${bad} of ${pages.length} legal page(s) the app links to are not approved, published and public yet`
    : `all ${pages.length} legal pages the app links to are final and public`;
  if (!bad) { console.log(summary); return 0; }
  console.log(`${mode === "warn" ? "::warning::" : "::error::"}${summary}. Release order: legal approval → website published (LEGAL_STATUS final) → pages public → only then app links reach players (docs/m5/store-package.md §1a).`);
  return mode === "warn" ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`::error::${e.message}`); process.exit(1); });
}
