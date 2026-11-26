"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SIGN_OUT_ALL } from "@/lib/signOutText";

/**
 * "Sign out of all devices" (F2 review S3, Paul 26 Nov), with a confirmation step. Supabase's global sign-out, from
 * this browser: every session of the account ends on the Auth server, and this browser's session is removed. What it
 * does not do (already-issued access tokens keep working until they expire, up to an hour by default) is in
 * src/lib/signOutText.ts and said in the confirmation. If the Auth server refuses or cannot be reached, auth-js keeps
 * this browser's session: nothing changed anywhere, and the page says so.
 */
export default function SignOutEverywhere() {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function confirm() {
    setBusy(true); setProblem(null);
    let failed = false;
    try { failed = !!(await createClient().auth.signOut({ scope: "global" })).error; } catch { failed = true; }
    setBusy(false);
    if (failed) { setProblem(SIGN_OUT_ALL.failed); return; }
    router.replace("/"); router.refresh();
  }

  if (!asking) {
    return (
      <div className="text-center">
        <button type="button" onClick={() => { setAsking(true); setProblem(null); }} className="py-2 text-sm text-muted underline">{SIGN_OUT_ALL.button}</button>
      </div>
    );
  }
  return (
    <section role="group" aria-labelledby="signout-all-title" className="card flex flex-col gap-3 p-4">
      <h2 id="signout-all-title" className="font-semibold">{SIGN_OUT_ALL.title}</h2>
      <p className="text-sm text-muted">{SIGN_OUT_ALL.body}</p>
      {problem && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{problem}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={confirm} className="flex-1 rounded-xl bg-cedar px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Signing out…" : SIGN_OUT_ALL.confirm}</button>
        <button type="button" disabled={busy} onClick={() => { setAsking(false); setProblem(null); }} className="flex-1 rounded-xl border border-grid bg-white px-4 py-3 text-sm font-semibold">{SIGN_OUT_ALL.cancel}</button>
      </div>
    </section>
  );
}
