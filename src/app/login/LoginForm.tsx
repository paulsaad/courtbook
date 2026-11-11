"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const ERRORS: Record<string, string> = {
  link: "That sign-in link expired, was already used, or was opened in a different browser than the one you asked from. Request a new one below.",
};
const COOLDOWN_S = 30;

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(() => { const e = params.get("error"); return e ? ERRORS[e] ?? "Sign-in failed. Please request a new link." : null; });
  const [cooldown, setCooldown] = useState(0);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setState("sending"); setError(null);
    const { error } = await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext)}` },
    });
    if (error) { setState("idle"); setError(error.message.includes("rate") ? "Too many requests. Wait a minute and try again." : error.message); return; }
    setState("sent"); setCooldown(COOLDOWN_S); setCode("");
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setVerifying(true); setError(null);
    const { error } = await createClient().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setVerifying(false);
    if (error) { setError("That code is wrong or expired. Check the latest email, or request a new one."); return; }
    router.replace(safeNext); router.refresh();
  }

  const input = "rounded-xl border border-grid bg-white px-4 py-3 text-base outline-none focus:border-action";
  const primary = "rounded-xl bg-action px-4 py-3.5 text-base font-medium text-white disabled:opacity-50";

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}

      {state === "sent" ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-grid bg-white p-4 text-sm">
            <p className="font-medium">Email sent to {email.trim()}</p>
            <p className="mt-1 text-muted">Tap the link <b>in the same browser you are using now</b>, or type the code from the email here.</p>
          </div>
          <form onSubmit={verify} className="flex gap-2">
            <input className={`${input} flex-1 tracking-widest`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" placeholder="12345678" value={code} onChange={(e) => setCode(e.target.value)} />
            <button disabled={verifying || !/^[0-9]{6,10}$/.test(code.trim())} className={primary}>{verifying ? "…" : "Continue"}</button>
          </form>
          <div className="flex items-center justify-between text-sm">
            <button onClick={() => send()} disabled={cooldown > 0 || state !== "sent"} className="text-action underline disabled:text-muted disabled:no-underline">{cooldown > 0 ? `Resend in ${cooldown}s` : "Resend email"}</button>
            <button onClick={() => { setState("idle"); setError(null); }} className="text-muted underline">Change email</button>
          </div>
        </div>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-3">
          <input type="email" required autoComplete="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
          <button type="submit" disabled={state === "sending"} className={primary}>{state === "sending" ? "Sending…" : "Send sign-in email"}</button>
          <p className="text-center text-xs text-muted">No password. We email you a link and a code.</p>
        </form>
      )}
    </main>
  );
}
