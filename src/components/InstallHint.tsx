"use client";

import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
const KEY = "cb_install_hint_dismissed";

/** One-line "Add to Home Screen" hint. Hidden when already installed or dismissed. */
export default function InstallHint() {
  const [show, setShow] = useState(false);
  const [ios, setIos] = useState(false);
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    try {
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (standalone || localStorage.getItem(KEY)) return;
    } catch { return; }
    const ua = navigator.userAgent;
    const isIos = /iPhone|iPad|iPod/.test(ua);
    setIos(isIos);
    if (isIos) { setShow(true); return; }
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as BeforeInstallPromptEvent); setShow(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!show) return null;
  const dismiss = () => { try { localStorage.setItem(KEY, "1"); } catch {} setShow(false); };
  const install = async () => { if (!prompt) return; await prompt.prompt(); const { outcome } = await prompt.userChoice; if (outcome === "accepted") setShow(false); };

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-grid bg-white px-4 py-3 text-sm">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-turf text-white">↓</span>
      <div className="flex-1">
        <div className="font-medium">Add CourtBook to your home screen</div>
        <div className="text-xs text-muted">{ios ? "Tap Share, then “Add to Home Screen”." : "Opens full-screen, like an app."}</div>
      </div>
      {!ios && prompt && <button onClick={install} className="rounded-xl bg-action px-3 py-2 text-white">Install</button>}
      <button onClick={dismiss} aria-label="Dismiss" className="px-1 text-muted">✕</button>
    </div>
  );
}
