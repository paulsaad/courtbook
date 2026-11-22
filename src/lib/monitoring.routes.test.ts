import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "./monitoring";

/** Every page.tsx / route.ts under src/app, as a route ("/club/[slug]/info"); route groups "(x)" do not count. */
function appRoutes(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...appRoutes(p, /^\(.*\)$/.test(name) ? base : `${base}/${name}`));
    } else if (/^(page|route)\.(tsx?|jsx?)$/.test(name)) {
      out.push(base || "/");
    }
  }
  return out;
}

describe("ROUTES matches the website's pages and routes", () => {
  it("lists every page and route in src/app, and nothing that is not there (plus the app's own files)", () => {
    const files = ["/favicon.ico", "/icon.png", "/manifest.webmanifest"];
    expect([...ROUTES].sort()).toEqual([...appRoutes(join(process.cwd(), "src/app")), ...files].sort());
  });
  it("uses only [name] dynamic segments (no catch-all, which the matcher does not handle)", () => {
    for (const r of ROUTES) expect(r).not.toMatch(/\[\.\.\.|\[\[/);
  });
});
