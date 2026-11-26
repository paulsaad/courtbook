"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Away at least this long (phone locked, another app), the page's data is read again on return. */
export const STALE_AFTER_MS = 30_000;

/**
 * Players come back to CourtBook after changes made elsewhere: a booking cancelled on another device or at the
 * desk, a game left or changed. Local pilot build, 26 Nov: back in the app after 35 s, and on Back to Bookings,
 * the page still showed the cancelled booking as "Your next booking" and the game already left, because
 * Next.js shows the page it already has. This reads the page's data again (router.refresh: server data only;
 * what the player has typed or selected stays):
 * - when the page becomes visible again after STALE_AFTER_MS or more;
 * - after Back/Forward (popstate) and when the browser restores the page from its back-forward cache.
 * Not while the phone is offline: a refresh that cannot reach the server would replace the page with the
 * browser's offline page.
 */
export default function FreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
    const refresh = () => { if (navigator.onLine !== false) router.refresh(); };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      if (hiddenAt !== null && Date.now() - hiddenAt >= STALE_AFTER_MS) refresh();
      hiddenAt = null;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPopState = () => { clearTimeout(timer); timer = setTimeout(refresh, 0); };   // after Next.js has shown the page
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("popstate", onPopState);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [router]);
  return null;
}
