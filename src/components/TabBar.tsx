"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { IconCalendar, IconCourt, IconHome, IconUser } from "./Icons";

const HIDDEN = ["/login", "/auth", "/staff", "/admin", "/pay", "/coach"];
const TABS = [
  { href: "/", label: "Home", Icon: IconHome, match: (p: string) => p === "/" || p.startsWith("/matches") || p.startsWith("/coaches") || p.startsWith("/play") },
  { href: "/courts", label: "Courts", Icon: IconCourt, match: (p: string) => p.startsWith("/courts") || p.startsWith("/club") },
  { href: "/me", label: "Bookings", Icon: IconCalendar, match: (p: string) => p.startsWith("/me") || p.startsWith("/bookings") },
  { href: "/profile", label: "Profile", Icon: IconUser, match: (p: string) => p.startsWith("/profile") || p.startsWith("/notifications") },
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

  if (!signedIn || HIDDEN.some((h) => path === h || path.startsWith(h + "/"))) return null;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-grid bg-white/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="mx-auto grid max-w-md grid-cols-4">
        {TABS.map(({ href, label, Icon, match }) => {
          const on = match(path);
          return (
            <Link key={href} href={href === "/profile" && unread > 0 ? "/notifications" : href} className={`relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] ${on ? "font-bold text-ink" : "font-medium text-[#8a918e]"}`}>
              {on && <span className="absolute top-1.5 h-[3px] w-[18px] rounded-full bg-cedar" />}
              <Icon size={26} className={on ? "text-turf" : ""} />
              {label}
              {href === "/profile" && unread > 0 && <span className="absolute right-[calc(50%-20px)] top-2 min-w-[18px] rounded-full bg-cedar px-1 text-center text-[10px] font-bold leading-[18px] text-white">{unread}</span>}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
