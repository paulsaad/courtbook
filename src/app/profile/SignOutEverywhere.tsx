"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SIGN_OUT_ALL } from "@/lib/signOutText";
import { signOutAllDevices } from "@/lib/signOutAll";

/**
 * "Sign out of all devices" (F2 review S3, Paul 26 Nov), with a confirmation step. Supabase's global sign-out, from
 * this browser: every session of the account ends on the Auth server, and this browser's session is removed. What it
 * does not do (already-issued access tokens keep working until they expire, at the project's JWT expiry) is in
 * src/lib/signOutText.ts and said in the confirmation. The Auth server must confirm the revocation before this browser
 * is cleared (src/lib/signOutAll.ts); otherwise this browser stays signed in and the page says the others may be too.
 * If this browser's session had already ended, it is cleared too and the page says so, with a way to sign in again
 * (follow-up 27 Nov: it used to stay looking signed in).
 */
export default function SignOutEverywhere() {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  async function confirm() {
    setBusy(true); setProblem(null);
    // the server confirms the revocation before this browser is cleared (src/lib/signOutAll.ts, re-review R103-1)
    const r = await signOutAllDevices(createClient().auth);
    setBusy(false);
    if (!r.ok && r.reason === "this_device_ended") { setEnded(true); return; }   // this browser is now signed out
    if (!r.ok) { setProblem(SIGN_OUT_ALL.failed); return; }
    router.replace("/"); router.refresh();
  }

  if (ended) {
    return (
      <section role="alert" className="card flex flex-col gap-3 p-4">
        <p className="text-sm">{SIGN_OUT_ALL.thisDeviceEnded}</p>
        <Link href="/login?next=/profile" className="rounded-xl bg-cedar px-4 py-3 text-center text-sm font-semibold text-white">Sign in again</Link>
      </section>
    );
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
