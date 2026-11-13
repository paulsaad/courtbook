import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; session: Session };

/**
 * Reads the stored session once at startup, then follows auth changes.
 *
 * The "loading" state matters: it is the window in which the session is being
 * read back out of SecureStore after the app was killed. Treating that window
 * as signed-out would bounce the user to the sign-in screen on every cold
 * start, which would look like the session had not persisted even when it had.
 */
export function useSession(): SessionState {
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

  return state;
}
