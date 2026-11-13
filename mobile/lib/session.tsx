import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";

export type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: Session };

const SessionContext = createContext<SessionState>({ status: "loading" });

/**
 * Whose data the cache may hold. `undefined` = not known yet (cold start), `null` = nobody.
 * The cache must be emptied whenever this changes between two known values: signing out,
 * a session that expired or was revoked on the server, or a different account signing in.
 * A token refresh keeps the same user and keeps the cache.
 */
export function cacheOwnerChanged(previous: string | null | undefined, next: string | null): boolean {
  return previous !== undefined && previous !== next;
}

/**
 * One subscription to Supabase auth for the whole app; screens read it with useSession().
 *
 * "loading" is the window in which the session is read back out of SecureStore after the app was
 * killed; treating it as signed-out would bounce the person to sign-in on every cold start.
 *
 * Every auth change goes through here — explicit sign-out, expiry, revocation (Supabase emits
 * SIGNED_OUT), and a different account signing in — so this is also where the cached data of the
 * previous person is dropped. It happens in the auth callback, before the new state renders, so
 * no screen can show one person's bookings to another for even a frame.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const owner = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;

    function apply(session: Session | null) {
      if (!alive) return;
      const next = session?.user.id ?? null;
      if (cacheOwnerChanged(owner.current, next)) queryClient.clear();
      owner.current = next;
      setState(session ? { status: "signed-in", session } : { status: "signed-out" });
    }

    supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => apply(session));

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [queryClient]);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}
