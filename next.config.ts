import type { NextConfig } from "next";

/** Security headers on every response (website completion W1). HSTS is already sent by Vercel. A full
 *  Content-Security-Policy is a later item (audit O1); only framing is restricted here. */
export const securityHeaders = [
  // no other site may show CourtBook inside a frame (clickjacking on staff and admin actions)
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera and microphone: never used. Location: CourtBook's own pages may ask (the approved optional "Use my
  // location" for nearby clubs, still behind the browser's own prompt); embedded third-party frames may not.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
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
