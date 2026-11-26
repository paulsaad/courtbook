import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "./globals.css";
import TabBar from "@/components/TabBar";
import FreshOnReturn from "@/components/FreshOnReturn";

export const metadata: Metadata = {
  title: "CourtBook",
  description: "Book sports courts, find players and coaches across Lebanon",
  applicationName: "CourtBook",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "CourtBook" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0f7a47",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {/* Desktop (≥ 1024 px): room for the fixed top bar instead of the bottom tab bar. */}
        <div id="main" tabIndex={-1} className="pb-[calc(3.5rem+env(safe-area-inset-bottom))] outline-none lg:pb-0 lg:pt-16">{children}</div>
        <TabBar />
        <FreshOnReturn />
      </body>
    </html>
  );
}
