"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * M2: "Delete my account" on the profile page. Asking is immediate; the deletion itself is done by CourtBook
 * (manual at launch) and can be cancelled until then. While a request is open the database refuses new bookings,
 * games and joins (0079). Before 0079 exists the section says nothing and shows nothing.
 */
type State = { status: "requested" | "data_removed"; requested_at: string } | null;
const MESSAGES: Record<string, string> = {
  staff_role: "You are staff at a club. Ask the club to remove you from its staff first, then try again.",
  admin_role: "Admin accounts cannot be deleted here. Remove the admin role first.",
};

export default function DeleteAccount() {
  const supabase = createClient();
  const [state, setState] = useState<State | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.rpc("my_account_deletion").then(({ data, error }) => {
      if (error) { setState(undefined); return; }       // before 0079: the section stays hidden
      setState((data as State) ?? null);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === undefined) return null;

  async function request() {
    setBusy(true); setError(null);
    const { data, error } = await supabase.rpc("request_account_deletion", { p_via: "web" });
    setBusy(false);
    if (error) { setError(MESSAGES[error.message] ?? "That did not work. Please try again."); return; }
    setConfirming(false);
    setState(data as State);
  }
  async function cancel() {
    setBusy(true); setError(null);
    const { error } = await supabase.rpc("cancel_account_deletion");
    setBusy(false);
    if (error) { setError("That did not work. Please try again."); return; }
    setState(null);
  }

  return (
    <section className="card flex flex-col gap-3 p-4" aria-labelledby="delete-account">
      <div id="delete-account" className="eyebrow">Delete account</div>
      {state ? (
        <>
          <p className="text-sm">
            You asked to delete your account on {new Date(state.requested_at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.
            We will delete it soon. Until then you cannot make new bookings, join games or send messages.
          </p>
          {state.status === "requested" && (
            <button type="button" onClick={cancel} disabled={busy} className="btn btn-secondary">{busy ? "Cancelling…" : "Keep my account (cancel the request)"}</button>
          )}
        </>
      ) : confirming ? (
        <>
          <p className="text-sm">
            This deletes your name, phone number, email sign-in, coach profile and chat messages, and takes you out of your
            games. Upcoming bookings are cancelled under the club&apos;s normal rules, and games you organise are cancelled.
            Clubs keep past bookings and payments without your name, for their records. You can cancel until we process it.
          </p>
          <button type="button" onClick={request} disabled={busy} className="btn btn-primary">{busy ? "Sending…" : "Yes, delete my account"}</button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="btn btn-secondary">Not now</button>
        </>
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
