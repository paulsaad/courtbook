// Module hook for pipeline_e2e: the website's "@/..." imports (tsconfig paths) → src/..., extensionless → .ts.
// Registered by pipeline_e2e.sh with --import ./supabase/tests/m86/alias_register.mjs. Test-only.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const src = new URL("../../../src/", import.meta.url);
export async function resolve(spec, ctx, next) {
  if (spec.startsWith("@/")) {
    const p = fileURLToPath(new URL(spec.slice(2), src));
    for (const ext of [".ts", ".tsx", "/index.ts"]) if (existsSync(p + ext)) return { url: pathToFileURL(p + ext).href, shortCircuit: true };
  }
  return next(spec, ctx);
}
