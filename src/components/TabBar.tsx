"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { NOTICES_READ_EVENT } from "@/lib/noticeRead";
import { IconBell, IconCalendar, IconCourt, IconHome, IconUser } from "./Icons";
import { Wordmark } from "./Brand";

const HIDDEN = ["/login", "/auth", "/staff", "/admin", "/pay", "/coach"];
/** Desktop (≥ 1024 px): staff and admin pages have their own bar (WorkNav); sign-in and payment stay focused. */
const DESKTOP_HIDDEN = ["/login", "/auth", "/staff", "/admin", "/pay"];
const under = (path: string, list: string[]) => list.some((h) => path === h || path.startsWith(h + "/"));

const TABS = [
  { href: "/", label: "Home", Icon: IconHome, match: (p: string) => p === "/" || p.startsWith("/matches") || p.startsWith("/coaches") || p.startsWith("/play") },
  { href: "/courts", label: "Courts", Icon: IconCourt, match: (p: string) => p.startsWith("/courts") || p.startsWith("/club") },
  { href: "/me", label: "Bookings", Icon: IconCalendar, match: (p: string) => p.startsWith("/me") || p.startsWith("/bookings") },
  { href: "/profile", label: "Profile", Icon: IconUser, match: (p: string) => p.startsWith("/profile") || p.startsWith("/notifications") },
];

/** Top bar destinations on desktop. Signed out: only what a visitor can use, plus Sign in. */
export const DESKTOP_LINKS = [
  { href: "/", label: "Home", signedIn: false, match: (p: string) => p === "/" || p.startsWith("/coaches") || p.startsWith("/levels") },
  { href: "/courts", label: "Courts", signedIn: false, match: (p: string) => p.startsWith("/courts") || p.startsWith("/club") },
  { href: "/play", label: "Find a game", signedIn: false, match: (p: string) => p.startsWith("/play") || p.startsWith("/matches") },
  { href: "/me", label: "Bookings", signedIn: true, match: (p: string) => p.startsWith("/me") || p.startsWith("/bookings") },
  { href: "/profile", label: "Profile", signedIn: true, match: (p: string) => p.startsWith("/profile") || p.startsWith("/coach") },
];

/**
 * Player navigation. Phones and tablets (< 1024 px): the bottom tab bar, exactly as before (hidden on
 * staff/admin/auth/pay/coach routes and when signed out). Desktop (≥ 1024 px): a top bar instead.
 */
/**
 * H7 (Session B's round-3 handover): the desktop top bar was in the page after the content, so the first Tab landed
 * in the content and "Skip to content" and the top navigation came last (WCAG 2.4.3). It is now placed in the
 * layout's #top-nav slot, before #main, so keyboard and screen-reader order match what is shown. The phone bar
 * stays after the content. Rendered only on the client (after the sign-in check), so the slot exists; without a
 * slot (tests, other layouts) it stays where it was.
 */
function inTopSlot(bar: React.ReactElement) {
  const slot = document.getElementById("top-nav");
  return slot ? createPortal(bar, slot) : bar;
}

export default function TabBar() {
  const path = usePathname();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    const supabase = createClient();
    let alive = true;
    const load = () => supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!alive) return;
      setSignedIn(!!user);
      if (!user) return;
      const { count } = await supabase.from("notifications").select("*", { count: "exact", head: true }).eq("profile_id", user.id).is("read_at", null);
      if (alive && typeof count === "number") setUnread(count);
    }, () => {});
    void load();
    // H18: the count is also read again when the page is shown again (notices read or received on another device)
    // and when a game page has just marked its notices read (H11; a #91 refresh keeps the same path). One head-only
    // count per event; no polling.
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(NOTICES_READ_EVENT, load);
    return () => { alive = false; document.removeEventListener("visibilitychange", onVisible); window.removeEventListener(NOTICES_READ_EVENT, load); };
  }, [path]);
  return (
    <>
      {signedIn && !under(path, HIDDEN) && (
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-20 border-t border-grid bg-white/95 backdrop-blur lg:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <div className="mx-auto grid max-w-md grid-cols-4">
            {TABS.map(({ href, label, Icon, match }) => {
              const on = match(path);
              return (
                <Link key={href} href={href === "/profile" && unread > 0 ? "/notifications" : href} aria-current={on ? "page" : undefined}
                  aria-label={href === "/profile" && unread > 0 ? `Profile, ${unread} unread notification${unread === 1 ? "" : "s"}` : undefined}
                  className={`relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] ${on ? "font-bold text-ink" : "font-medium text-[#5f6663]"}`}>
                  {on && <span className="absolute top-1.5 h-[3px] w-[18px] rounded-full bg-cedar" />}
                  <Icon size={26} className={on ? "text-turf" : ""} />
                  {label}
                  {href === "/profile" && unread > 0 && <span className="absolute right-[calc(50%-20px)] top-2 min-w-[18px] rounded-full bg-cedar px-1 text-center text-[10px] font-bold leading-[18px] text-white">{unread}</span>}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
      {signedIn !== null && !under(path, DESKTOP_HIDDEN) && inTopSlot(<DesktopBar path={path} signedIn={signedIn} unread={unread} />)}
    </>
  );
}

function DesktopBar({ path, signedIn, unread }: { path: string; signedIn: boolean; unread: number }) {
  return (
    <header className="fixed inset-x-0 top-0 z-20 hidden h-16 border-b border-grid bg-white/95 backdrop-blur lg:block">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-30 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:shadow">Skip to content</a>
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-[1200px] items-center gap-1 px-6">
        <Link href="/" aria-label="CourtBook home" className="mr-6 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-turf"><Wordmark size={22} /></Link>
        {DESKTOP_LINKS.filter((l) => signedIn || !l.signedIn).map(({ href, label, match }) => {
          const on = match(path);
          return (
            <Link key={href} href={href} aria-current={on ? "page" : undefined}
              className={`relative flex h-16 items-center px-3 text-[15px] focus-visible:outline-2 focus-visible:-outline-offset-8 focus-visible:outline-turf ${on ? "font-bold text-ink" : "font-medium text-[#5f6663] hover:text-ink"}`}>
              {label}
              {on && <span className="absolute inset-x-3 bottom-0 h-[3px] rounded-full bg-cedar" />}
            </Link>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          {signedIn ? (
            <Link href="/notifications" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
              className={`relative grid h-11 w-11 place-items-center rounded-full border border-grid bg-white focus-visible:outline-2 focus-visible:outline-turf ${path.startsWith("/notifications") ? "text-turf" : "text-ink"}`}>
              <IconBell size={22} />
              {unread > 0 && <span className="absolute -right-1 -top-1 min-w-[18px] rounded-full bg-cedar px-1 text-center text-[10px] font-bold leading-[18px] text-white">{unread}</span>}
            </Link>
          ) : (
            <Link href="/login" className="rounded-xl bg-turf px-4 py-2.5 text-[15px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-turf">Sign in</Link>
          )}
        </div>
      </nav>
    </header>
  );
}
