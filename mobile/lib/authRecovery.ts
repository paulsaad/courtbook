import { router } from "expo-router";
import { supabase } from "./supabase";

/**
 * What happens when the server rejects the session mid-use (an access token that can no longer be
 * refreshed, a revoked account): sign out on this phone only, then open sign-in over the screen the
 * person was on, so finishing sign-in returns them there.
 *
 * `scope: "local"` matters: the session is already dead on the server, and a global sign-out would
 * be one more request that fails.
 *
 * Several queries usually fail together when this happens; only the first one acts.
 */
let currentPath = "/";
let recovering = false;

export function trackPath(path: string) {
  if (path !== "/sign-in") currentPath = path;
}

export function lastPath(): string {
  return currentPath;
}

export async function recoverFromAuthFailure(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    await supabase.auth.signOut({ scope: "local" });
    router.push({ pathname: "/sign-in", params: { returnTo: currentPath, reason: "expired" } });
  } finally {
    // Long enough for the burst of failing queries to settle, short enough that a second real
    // expiry later in the session is still handled.
    setTimeout(() => {
      recovering = false;
    }, 3000);
  }
}
