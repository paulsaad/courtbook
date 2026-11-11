"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Cedar } from "@/components/Brand";

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

  const [gBusy, setGBusy] = useState(false);
  async function google() {
    setGBusy(true); setError(null);
    const { error } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeNext)}`, queryParams: { prompt: "select_account" } },
    });
    if (error) { setGBusy(false); setError("Google sign-in is not available right now. Use your email below."); }
  }

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
      <div className="flex items-center gap-2"><Cedar size={26} /><h1 className="text-2xl font-extrabold tracking-tight">Sign in to CourtBook</h1></div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      {state !== "sent" && (
        <>
          <button type="button" onClick={google} disabled={gBusy} className="flex w-full items-center justify-center gap-3 rounded-2xl border border-grid bg-white px-4 py-3.5 text-base font-semibold disabled:opacity-50">
            <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.4 28.7A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.7-4.1-13.6-9.9l-7.8 6C6.5 42.6 14.6 48 24 48z"/></svg>
            {gBusy ? "Opening Google…" : "Continue with Google"}
          </button>
          <div className="flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-grid" />or with your email<span className="h-px flex-1 bg-grid" /></div>
        </>
      )}

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
          <p className="text-center text-xs text-muted">No password. We email you a link and a code. Once per phone — you stay signed in.</p>
        </form>
      )}
    </main>
  );
}
