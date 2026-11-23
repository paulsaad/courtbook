"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

/** The question and the two answers. "Under 18" records nothing: the person is told CourtBook is not for them. */
export default function AgeForm({ next }: { next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [under, setUnder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc("confirm_age", { p_is_18_or_over: true, p_via: "web" });
    if (error) { setBusy(false); setError(friendlyError(error.message)); return; }
    router.replace(next);
    router.refresh();
  }

  if (under) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-4 p-5 pt-12">
        <h1 className="text-2xl font-extrabold tracking-tight">CourtBook is for ages 18 and over</h1>
        <p className="text-[15px]">You can&apos;t book courts, join games or chat on CourtBook.</p>
        <form action="/auth/signout" method="post"><button className="btn btn-secondary">Sign out</button></form>
        <button type="button" onClick={() => setUnder(false)} className="text-sm text-muted">I answered by mistake</button>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-4 p-5 pt-12">
      <h1 className="text-2xl font-extrabold tracking-tight">Are you 18 or over?</h1>
      <p className="text-[15px]">CourtBook is for people aged 18 and over. We ask once and keep only your answer and when you gave it —
        no date of birth.</p>
      <button type="button" onClick={confirm} disabled={busy} className="btn btn-primary">{busy ? "Saving…" : "Yes, I am 18 or over"}</button>
      <button type="button" onClick={() => setUnder(true)} disabled={busy} className="btn btn-secondary">No, I am under 18</button>
      {error && <p role="alert" className="text-sm text-cedar">{error}</p>}
    </main>
  );
}
