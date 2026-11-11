import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
import TabBar from "@/components/TabBar";

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
    <html lang="en" className={inter.variable}>
      <body className="min-h-screen antialiased">
        <div className="pb-[calc(3.5rem+env(safe-area-inset-bottom))]">{children}</div>
        <TabBar />
      </body>
    </html>
  );
}
