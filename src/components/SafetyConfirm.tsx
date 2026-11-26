"use client";

import Link from "next/link";
import { useState } from "react";
import { useDialog } from "@/components/useDialog";
import { BLOCKED_PATH } from "@/lib/gameSafety";

/**
 * The one confirmation before blocking or unblocking (as the app's confirmBlock and its unblock alert):
 * a title, the explanation, Cancel and the action. A refusal is shown inside the dialog and it stays
 * open, so the player can try again or cancel.
 */
export default function SafetyConfirm({ title, text, action, destructive, linkBlocked, onConfirm, onClose }: {
  title: string; text: string; action: string; destructive?: boolean; linkBlocked?: boolean;
  onConfirm: () => Promise<string | null>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useDialog<HTMLElement>(true, onClose, { canClose: !busy });

  async function go() {
    if (busy) return;
    setBusy(true); setProblem(null);
    const p = await onConfirm();
    setBusy(false);
    if (p) setProblem(p); else onClose();
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end bg-ink/45 lg:items-center lg:justify-center lg:p-6" onClick={() => { if (!busy) onClose(); }}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-label={title} className="sheet-enter w-full rounded-t-3xl bg-paper px-5 pt-5 shadow-2xl outline-none lg:max-w-md lg:rounded-3xl" style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm">{text}{linkBlocked && <> You can unblock them in <Link href={BLOCKED_PATH} className="text-action underline">Blocked players</Link>.</>}</p>
        {problem && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{problem}</p>}
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="flex-1 rounded-xl border border-grid bg-white px-4 py-3 font-medium">Cancel</button>
          <button type="button" onClick={() => void go()} disabled={busy} className={`flex-1 rounded-xl px-4 py-3 font-medium text-white disabled:opacity-50 ${destructive ? "bg-danger" : "bg-action"}`}>
            {busy ? "One moment…" : action}
          </button>
        </div>
      </section>
    </div>
  );
}
