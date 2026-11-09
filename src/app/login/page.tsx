"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(new URLSearchParams(window.location.search).get("next") ?? "/")}` },
    });
    if (error) {
      setState("error");
      setMessage(error.message);
    } else {
      setState("sent");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      {state === "sent" ? (
        <p>Check your email for a sign-in link. Open it on this phone.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-xl border border-grid bg-white px-4 py-3 text-base outline-none focus:border-action"
          />
          <button
            type="submit"
            disabled={state === "sending"}
            className="rounded-xl bg-action px-4 py-3.5 text-base font-medium text-white disabled:opacity-50"
          >
            {state === "sending" ? "Sending…" : "Send sign-in link"}
          </button>
          {state === "error" && <p className="text-sm text-red-600">{message}</p>}
        </form>
      )}
    </main>
  );
}
