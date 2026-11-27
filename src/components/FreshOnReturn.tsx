"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Away at least this long (phone locked, another app), the page's data is read again on return. */
export const STALE_AFTER_MS = 30_000;
/** How long the reachability check may take before the refresh is skipped. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Can CourtBook answer right now? `navigator.onLine` only says the phone has a network: on a captive Wi-Fi, a
 * dropped mobile connection or with the site down it still says true, and a refresh that cannot reach the
 * server makes Next.js fall back to a full page load — the browser's error page, and the player's unfinished
 * form gone (verified on the local pilot build). /api/health answers 200 only when the site and its database
 * respond, which is what the page's data needs.
 */
export async function serverReachable(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl("/api/health", { cache: "no-store", signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Players come back to CourtBook after changes made elsewhere: a booking cancelled on another device or at the
 * desk, a game left or changed. Local pilot build, 26 Nov: back in the app after 35 s, and on Back to Bookings,
 * the page still showed the cancelled booking as "Your next booking" and the game already left, because
 * Next.js shows the page it already has. This reads the page's data again (router.refresh: server data only;
 * what the player has typed or selected stays):
 * - when the page becomes visible again after STALE_AFTER_MS or more;
 * - after Back/Forward (popstate) and when the browser restores the page from its back-forward cache.
 * Only when CourtBook can be reached (serverReachable): a refresh that cannot reach the server would replace
 * the page — and anything typed on it — with the browser's error page. Otherwise nothing happens; the page
 * stays as it is and the next return or navigation tries again.
 */
export default function FreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
    let checking = false;
    const refresh = () => {
      if (checking) return;                       // one check at a time (Back pressed twice quickly)
      checking = true;
      void serverReachable().then((ok) => { checking = false; if (ok) router.refresh(); });
    };
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
