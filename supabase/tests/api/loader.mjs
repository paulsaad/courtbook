// Node module hooks so the app's own modules (mobile/lib/*.ts) run in node against the local API:
//   expo-crypto  → node's crypto;  ./supabase (from mobile/lib) → the client the test chooses;  @shared/* → mobile/shared;
//   extensionless relative imports → the .ts file.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = new URL(".", import.meta.url);
export async function resolve(spec, ctx, next) {
  if (spec === "expo-crypto") return { url: new URL("shims/expo-crypto.mjs", here).href, shortCircuit: true };
  // "server-only" guards a Next.js bundle; in node it is an empty module
  if (spec === "server-only") return { url: new URL("shims/empty.mjs", here).href, shortCircuit: true };
  // the website's own reservation module (src/lib/reserve.ts) runs too: its Supabase client is the one the test sets
  if (spec === "@/lib/supabase/client") return { url: new URL("shims/webclient.mjs", here).href, shortCircuit: true };
  if (spec.startsWith("@shared/")) return { url: new URL(`../../../mobile/shared/${spec.slice(8)}.ts`, here).href, shortCircuit: true };
  if ((spec === "./supabase" || spec === "../lib/supabase") && ctx.parentURL?.includes("/mobile/")) return { url: new URL("shims/supabase.mjs", here).href, shortCircuit: true };
  if (spec.startsWith(".") && ctx.parentURL && !/\.[mc]?[jt]s$/.test(spec)) {
    const p = fileURLToPath(new URL(spec, ctx.parentURL));
    for (const ext of [".ts", ".tsx", "/index.ts"]) if (existsSync(p + ext)) return { url: pathToFileURL(p + ext).href, shortCircuit: true };
  }
  return next(spec, ctx);
}
