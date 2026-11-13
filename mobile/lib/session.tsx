import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: Session };

const SessionContext = createContext<SessionState>({ status: "loading" });

/**
 * One subscription to Supabase auth for the whole app; screens read it with useSession().
 *
 * The "loading" state matters: it is the window in which the session is being read back out of
 * SecureStore after the app was killed. Treating that window as signed-out would bounce the user
 * to sign-in on every cold start and look exactly like the session had not persisted.
 *
 * A refresh token revoked on the server (signed out elsewhere, account removed) makes Supabase
 * emit SIGNED_OUT and clear the stored session; this provider then reports "signed-out" and every
 * signed-in-only screen shows its sign-in prompt. Nothing else needs to listen for it.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let alive = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setState(data.session ? { status: "signed-in", session: data.session } : { status: "signed-out" });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setState(session ? { status: "signed-in", session } : { status: "signed-out" });
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  return useContext(SessionContext);
}
