"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
const KEY = "cb_install_hint_dismissed";
const isIosDevice = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** Browser facts read the same way on the server and during hydration (false there), then for real. */
const noSubscribe = () => () => {};
function installed(): boolean {
  try {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
    return standalone || !!localStorage.getItem(KEY);
  } catch { return true; }
}
const iosHint = () => isIosDevice() && !installed();

/**
 * One-line "Add to Home Screen" hint. Hidden when already installed or dismissed.
 *
 * The iPhone check used to run in the first render, so the server's HTML (no hint) and the iPhone's
 * first render (hint) differed: React error #418 (hydration mismatch) on every Home visit from an iPhone,
 * and the page re-rendered from scratch. useSyncExternalStore gives the server's answer (no hint) during
 * hydration and the iPhone's answer right after.
 */
export default function InstallHint() {
  const ios = useSyncExternalStore(noSubscribe, isIosDevice, () => false);
  const iosEligible = useSyncExternalStore(noSubscribe, iosHint, () => false);
  const [dismissed, setDismissed] = useState(false);
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      if (installed()) return;
      setPrompt(e as BeforeInstallPromptEvent);   // Android: shown once the browser offers installing
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const show = !dismissed && (iosEligible || !!prompt);
  if (!show) return null;
  const dismiss = () => { try { localStorage.setItem(KEY, "1"); } catch {} setDismissed(true); };
  const install = async () => { if (!prompt) return; await prompt.prompt(); const { outcome } = await prompt.userChoice; if (outcome === "accepted") setDismissed(true); };

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-grid bg-white px-4 py-3 text-sm">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-turf text-white" aria-hidden="true">↓</span>
      <div className="flex-1">
        <div className="font-medium">Add CourtBook to your home screen</div>
        <div className="text-xs text-muted">{ios ? "Tap Share, then “Add to Home Screen”." : "Opens full-screen, like an app."}</div>
      </div>
      {!ios && prompt && <button onClick={install} className="rounded-xl bg-action px-3 py-2 text-white">Install</button>}
      <button onClick={dismiss} aria-label="Dismiss" className="px-1 text-muted">✕</button>
    </div>
  );
}
