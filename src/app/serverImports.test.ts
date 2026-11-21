/**
 * Regression (club Info page, found 21 Nov 2026): a server component may import a React component
 * from a "use client" file, but not a plain value (a list, a constant, a helper) — on the server that
 * arrives as a client reference, not the value ("FACILITIES.map is not a function").
 * Checks every file without "use client" under src/app and src/components.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) files.push(p); } };
walk("src/app"); walk("src/components");
const isClient = (p: string) => /^\s*["']use client["']/.test(readFileSync(p, "utf8"));
function target(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? resolve("src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base + ".tsx", base + ".ts", join(base, "index.tsx"), join(base, "index.ts")]) if (existsSync(c)) return c;
  return null;
}

describe("server files import only components (or types) from \"use client\" files", () => {
  it("no plain value crosses into a server file", () => {
    const bad: string[] = [];
    for (const f of files.filter((p) => !isClient(p))) {
      for (const m of readFileSync(f, "utf8").matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
        if (m[1]) continue;
        const t = target(f, m[3]);
        if (!t || !isClient(t)) continue;
        const named = /\{([^}]*)\}/.exec(m[2])?.[1] ?? "";
        for (const n of named.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (n.startsWith("type ")) continue;
          const name = n.split(/\s+as\s+/)[0];
          if (!/^[A-Z][a-z]/.test(name)) bad.push(`${f}: ${name} from ${m[3]}`);   // PascalCase = component
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
