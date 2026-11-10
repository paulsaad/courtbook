import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CourtBook",
    short_name: "CourtBook",
    description: "Book sports courts, find players and coaches across Lebanon",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f5f0",
    theme_color: "#1f7a4d",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
