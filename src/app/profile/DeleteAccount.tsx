"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CONFIRM_TITLE, CONFIRM_TEXT, REAUTH_TEXT, legacyRequestText } from "@/lib/deletion/copy";

/**
 * M2 (0086): "Delete my account" on the profile page. One confirmation, no undo (D1). Confirming calls
 * /api/account/close, which closes the account, signs the person out everywhere and starts the deletion; this browser
 * then clears its own session and shows /account-closed. Nothing here ever says the data IS deleted (D5).
 *
 * Review 23 Nov:
 *  - closing needs a recent sign-in. If this session is older than 10 minutes, the server answers reauth_required:
 *    we email a sign-in code to the account's address, the person types it, and the same confirmation goes through.
 *    No second confirmation; only the code.
 *  - someone who asked to delete in an older app version (request-and-wait) sees that request with "Keep my
 *    account", as that app promised, and can also delete now.
 * If this browser is somehow still signed in to an account that is already closed, it signs out and shows the same page.
 * Before 0086 exists the section shows nothing.
 */
type State = { status: string; requested_at?: string; closed?: boolean } | null;
const MESSAGES: Record<string, string> = {
  staff_role: "You are staff at a club, so this account can't be deleted here. Contact CourtBook support.",
  admin_role: "Admin accounts can't be deleted here. Contact CourtBook support.",
  not_authenticated: "Your session has ended. Sign in again, then try again.",
};
const GENERIC = "That did not work, and nothing was changed. Please try again.";

async function leave(supabase: ReturnType<typeof createClient>) {
  try { await supabase.auth.signOut({ scope: "local" }); } catch { /* the server already signed this session out */ }
  // a full page load, not router.push: nothing the browser held for this person survives into the next page
  window.location.assign("/account-closed"); // eslint-disable-line @next/next/no-location-assign-relative-destination
}

export default function DeleteAccount() {
  const supabase = createClient();
  const [state, setState] = useState<State | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeFor, setCodeFor] = useState<string | null>(null);   // the address a sign-in code was sent to
  const [code, setCode] = useState("");

  useEffect(() => {
    supabase.rpc("my_account_deletion").then(({ data, error }) => {
      if (error) { setState(undefined); return; }       // before 0079/0086: the section stays hidden
      const s = (data as State) ?? null;
      if (s?.closed) { void leave(supabase); return; }
      setState(s);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === undefined || state?.closed) return null;

  async function sendCode(): Promise<boolean> {
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email;
    if (!email) { setError("We couldn't send you a sign-in code. Contact CourtBook support to delete your account."); return false; }
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) { setError("We couldn't send the code just now. Please try again in a minute."); return false; }
    setCodeFor(email); setCode("");
    return true;
  }

  async function confirm() {
    setBusy(true); setError(null);
    let res: Response | null = null;
    try {
      res = await fetch("/api/account/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    } catch { /* offline: unknown whether it reached us; the check below decides */ }
    if (res?.ok) { await leave(supabase); return; }
    const errCode = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : undefined;
    if (errCode === "reauth_required") { await sendCode(); setBusy(false); return; }
    if (!res || res.status >= 500) {
      // the close may have committed before the error: if the account is closed, leave anyway
      const { data } = await supabase.rpc("my_account_deletion");
      if ((data as State)?.closed) { await leave(supabase); return; }
    }
    setBusy(false);
    setError(MESSAGES[errCode ?? ""] ?? GENERIC);
  }

  async function verifyAndConfirm() {
    if (!codeFor) return;
    setBusy(true); setError(null);
    const { error } = await supabase.auth.verifyOtp({ email: codeFor, token: code.trim(), type: "email" });
    if (error) { setBusy(false); setError("That code didn't work. Check it, or send a new one."); return; }
    setCodeFor(null);
    await confirm();   // a fresh sign-in: the same confirmation now goes through
  }

  async function keep() {
    setBusy(true); setError(null);
    const { error } = await supabase.rpc("cancel_account_deletion");
    setBusy(false);
    if (error) { setError(GENERIC); return; }
    setState(null);
  }

  return (
    <section className="card flex flex-col gap-3 p-4" aria-labelledby="delete-account">
      <div id="delete-account" className="eyebrow">Delete account</div>
      {codeFor ? (
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verifyAndConfirm(); }}>
          <p className="text-sm">{REAUTH_TEXT} <b>{codeFor}</b></p>
          <label className="flex flex-col gap-1 text-sm">Sign-in code
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={10}
              className="min-h-11 rounded-xl border border-grid bg-white px-3 py-2.5 text-base tracking-widest" />
          </label>
          <button type="submit" disabled={busy || code.trim().length < 6} className="btn btn-primary bg-cedar">{busy ? "Closing your account…" : "Confirm and delete my account"}</button>
          <button type="button" disabled={busy} onClick={() => void sendCode()} className="btn btn-secondary">Send a new code</button>
          <button type="button" disabled={busy} onClick={() => { setCodeFor(null); setConfirming(false); setError(null); }} className="btn btn-secondary">Keep my account</button>
        </form>
      ) : state?.status === "requested" && !confirming ? (
        <>
          <p className="text-sm">{legacyRequestText(state.requested_at)}</p>
          <button type="button" onClick={keep} disabled={busy} className="btn btn-secondary">Keep my account</button>
          <button type="button" onClick={() => setConfirming(true)} disabled={busy} className="py-1 text-left text-[15px] font-semibold text-cedar">Delete my account now…</button>
        </>
      ) : confirming ? (
        <div role="alertdialog" aria-labelledby="delete-account-title" aria-describedby="delete-account-text" className="flex flex-col gap-3">
          <h3 id="delete-account-title" className="font-bold">{CONFIRM_TITLE}</h3>
          <p id="delete-account-text" className="text-sm">{CONFIRM_TEXT}</p>
          <button type="button" onClick={confirm} disabled={busy} className="btn btn-primary bg-cedar">{busy ? "Closing your account…" : "Delete my account"}</button>
          <button type="button" onClick={() => { setConfirming(false); setError(null); }} disabled={busy} className="btn btn-secondary">Keep my account</button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted">Permanently delete your CourtBook account. <Link href="/delete-account" className="font-semibold text-turf">What is deleted</Link></p>
          <button type="button" onClick={() => setConfirming(true)} className="py-1 text-left text-[15px] font-semibold text-cedar">Delete my account…</button>
        </>
      )}
      {error && <p role="alert" className="text-sm text-cedar">{error}</p>}
    </section>
  );
}
