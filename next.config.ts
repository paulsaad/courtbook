import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pages read the auth cookie on every request; keep the classic dynamic-rendering model.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
