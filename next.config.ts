import type { NextConfig } from "next";

/** Security headers on every response (website completion W1). HSTS is already sent by Vercel. A full
 *  Content-Security-Policy is a later item (audit O1); only framing is restricted here. */
export const securityHeaders = [
  // no other site may show CourtBook inside a frame (clickjacking on staff and admin actions)
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // CourtBook uses none of these
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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
