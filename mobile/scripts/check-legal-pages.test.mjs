// node --test scripts/check-legal-pages.test.mjs   (run from mobile/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageProblems, readAppLinks } from "./check-legal-pages.mjs";

const final = (title) => `<!DOCTYPE html><html><head><title>${title}</title><meta name="viewport" content="width=device-width"></head>
<body><main><h1>${title}</h1><p class="text-sm">Last updated: <!-- -->1 March 2027</p><article>Text.</article></main></body></html>`;
const ok = { url: "https://courtbook.example/privacy", finalUrl: "https://courtbook.example/privacy", status: 200, headers: new Headers(), key: "privacy" };

test("a final, public, indexable page passes", () => {
  assert.deepEqual(pageProblems({ ...ok, html: final("Privacy policy — CourtBook") }), []);
});

test("today's draft page fails: draft notice, marked items, noindex, no date", () => {
  const draft = `<html><head><title>Privacy policy — CourtBook</title><meta name="robots" content="noindex, nofollow"></head><body>
  <aside role="note" aria-label="Draft notice"><p>Draft for review — not yet in force.</p></aside>
  <mark data-pending="decision">operator</mark><mark data-pending="legal">x</mark></body></html>`;
  const p = pageProblems({ ...ok, html: draft });
  assert.ok(p.some((x) => x.includes("2 marked unfinished")));
  assert.ok(p.includes("draft notice shown"));
  assert.ok(p.includes("robots meta says noindex"));
  assert.ok(p.includes('no "Last updated" date'));
});

test("not published or not public fails", () => {
  assert.ok(pageProblems({ ...ok, status: 404, html: "<title>404: This page could not be found.</title>" }).some((x) => x === "HTTP 404"));
  assert.ok(pageProblems({ ...ok, status: 401, html: "<title>Login – Vercel</title>" }).includes("HTTP 401"));
  // a 200 that is really a sign-in page on another origin
  const p = pageProblems({ ...ok, finalUrl: "https://vercel.com/login?next=x", html: "<title>Login – Vercel</title>" });
  assert.ok(p.includes("redirected to https://vercel.com"));
  assert.ok(p.some((x) => x.startsWith("title is")));
});

test("noindex in the X-Robots-Tag header fails; http fails", () => {
  assert.ok(pageProblems({ ...ok, headers: new Headers({ "x-robots-tag": "noindex" }), html: final("Privacy policy") }).includes("X-Robots-Tag says noindex"));
  assert.ok(pageProblems({ ...ok, url: "http://courtbook.example/privacy", finalUrl: undefined, html: final("Privacy policy") }).includes("not https"));
});

test("the wrong page (e.g. the home page) fails on its title", () => {
  assert.ok(pageProblems({ ...ok, key: "terms", html: final("CourtBook") }).some((x) => x.startsWith("title is")));
});

test("reads WEBSITE_URL and every page from the app's own mobile/lib/legal.ts", () => {
  const { base, pages } = readAppLinks(readFileSync(new URL("../lib/legal.ts", import.meta.url), "utf8"));
  assert.match(base, /^https:\/\//);
  assert.deepEqual(pages.map((p) => p.key), ["privacy", "terms", "delete-account"]);
  assert.deepEqual(pages.map((p) => p.path), ["/privacy", "/terms", "/delete-account"]);
});

test("the website's real titles are the ones expected (src/app pages)", () => {
  const src = (f) => readFileSync(new URL(`../../src/app/${f}/page.tsx`, import.meta.url), "utf8");
  assert.match(src("privacy"), /title: "Privacy policy — CourtBook"/);
  assert.match(src("terms"), /title: "Terms of use — CourtBook"/);
  assert.match(src("delete-account"), /title: "Delete your CourtBook account"/);
});
