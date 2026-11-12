import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Same "@/..." alias the app uses, so tests import modules exactly as the components do.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  esbuild: { jsx: "automatic" },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
