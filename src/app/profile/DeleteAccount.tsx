"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CONFIRM_TITLE, CONFIRM_TEXT } from "@/lib/deletion/copy";

/**
 * M2 (0086): "Delete my account" on the profile page. One confirmation, no undo (D1). Confirming calls
 * /api/account/close, which closes the account, signs the person out everywhere and starts the deletion; this browser
 * then clears its own session and shows /account-closed. Nothing here ever says the data IS deleted (D5).
 * If this browser is somehow still signed in to an account that is already closed, it signs out and shows the same page.
 * Before 0086 exists the section shows nothing.
 */
type State = { status: string; closed?: boolean } | null;
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

  useEffect(() => {
    supabase.rpc("my_account_deletion").then(({ data, error }) => {
      if (error) { setState(undefined); return; }       // before 0079/0086: the section stays hidden
      const s = (data as State) ?? null;
      if (s?.closed) { void leave(supabase); return; }
      setState(s);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === undefined || state?.closed) return null;

  async function confirm() {
    setBusy(true); setError(null);
    let res: Response | null = null;
    try {
      res = await fetch("/api/account/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    } catch { /* offline: unknown whether it reached us; the check below decides */ }
    if (res?.ok) { await leave(supabase); return; }
    const code = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : undefined;
    if (!res || res.status >= 500) {
      // the close may have committed before the error: if the account is closed, leave anyway
      const { data } = await supabase.rpc("my_account_deletion");
      if ((data as State)?.closed) { await leave(supabase); return; }
    }
    setBusy(false);
    setError(MESSAGES[code ?? ""] ?? GENERIC);
  }

  return (
    <section className="card flex flex-col gap-3 p-4" aria-labelledby="delete-account">
      <div id="delete-account" className="eyebrow">Delete account</div>
      {confirming ? (
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
