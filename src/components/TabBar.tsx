"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const HIDDEN = ["/login", "/auth", "/staff", "/admin", "/pay", "/coach"];
const TABS = [
  { href: "/", label: "Home", match: (p: string) => p === "/" || p.startsWith("/club") || p.startsWith("/coaches"), icon: "⌂" },
  { href: "/play", label: "Play", match: (p: string) => p.startsWith("/play") || p.startsWith("/matches"), icon: "◎" },
  { href: "/me", label: "My CourtBook", match: (p: string) => p.startsWith("/me") || p.startsWith("/bookings"), icon: "▤" },
  { href: "/profile", label: "Profile", match: (p: string) => p.startsWith("/profile") || p.startsWith("/notifications"), icon: "◯" },
];

/** Bottom navigation for player screens. Hidden on staff/admin/auth/pay routes and when signed out. */
export default function TabBar() {
  const path = usePathname();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const supabase = createClient();
    let alive = true;
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!alive) return;
      setSignedIn(!!user);
      if (!user) return;
      const { count } = await supabase.from("notifications").select("*", { count: "exact", head: true }).eq("profile_id", user.id).is("read_at", null);
      if (alive) setUnread(count ?? 0);
    });
    return () => { alive = false; };
  }, [path]);

  if (!signedIn || HIDDEN.some((h) => path.startsWith(h))) return null;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-grid bg-white/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="mx-auto grid max-w-md grid-cols-4">
        {TABS.map((t) => {
          const on = t.match(path);
          return (
            <Link key={t.href} href={t.href} className={`relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${on ? "text-ink" : "text-muted"}`}>
              <span className={`text-xl leading-none ${on ? "text-turf" : ""}`}>{t.icon}</span>
              <span className={on ? "font-medium" : ""}>{t.label}</span>
              {t.href === "/profile" && unread > 0 && <span className="absolute right-[calc(50%-18px)] top-2 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] leading-4 text-white">{unread}</span>}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
