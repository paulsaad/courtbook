"use client";

import { useState } from "react";
import { useDialog } from "@/components/useDialog";
import { REPORT_BLOCK_OFFER, REPORT_DANGER, REPORT_NOTE_MAX, REPORT_REASONS, REPORT_THANKS, type ReportReason } from "@/lib/gameSafety";

/**
 * Report a chat message (UX §4.6, as the app's ReportSheet): a reason, an optional note, "Send report".
 * After sending: the thanks sentence, the emergency line for "Threat or danger", and the offer to block.
 * No response time is promised. The reported player is named only as the chat already names them.
 */
export default function ReportSheet({ name, onSend, onBlock, onClose }: {
  name: string | null;
  onSend: (reason: ReportReason, note: string) => Promise<string | null>;
  onBlock: () => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ref = useDialog<HTMLElement>(true, onClose, { canClose: !busy });

  async function send() {
    if (!reason || busy) return;
    setBusy(true); setProblem(null);
    const p = await onSend(reason, note);
    setBusy(false);
    if (p) setProblem(p); else setSent(true);
  }

  const title = sent ? "Report sent" : "Report message";
  return (
    <div className="fixed inset-0 z-30 flex items-end bg-ink/45 lg:items-center lg:justify-center lg:p-6" onClick={() => { if (!busy) onClose(); }}>
      <section ref={ref} role="dialog" aria-modal="true" aria-label={title} className="sheet-enter flex max-h-[92vh] w-full flex-col rounded-t-3xl bg-paper shadow-2xl outline-none lg:max-h-[85vh] lg:max-w-lg lg:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="-mr-2 flex h-11 w-11 items-center justify-center text-xl text-muted">×</button>
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto px-5 pt-2 text-sm" style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}>
          {sent ? (
            <>
              <p role="status">{REPORT_THANKS} {REPORT_BLOCK_OFFER}</p>
              {reason === "danger" && <p className="font-semibold">{REPORT_DANGER}</p>}
              <button type="button" onClick={onBlock} className="rounded-xl border border-grid bg-white px-4 py-3 font-medium text-danger">Block {name ?? "this player"}</button>
              <button type="button" onClick={onClose} className="rounded-xl px-4 py-3 font-medium text-muted">Done</button>
            </>
          ) : (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-muted">Why are you reporting this message?</legend>
                {REPORT_REASONS.map((r) => (
                  <label key={r.key} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border bg-white px-3 py-2 ${reason === r.key ? "border-ink shadow-[0_0_0_2px_#121614]" : "border-grid"}`}>
                    <input type="radio" name="report-reason" value={r.key} checked={reason === r.key} onChange={() => setReason(r.key)} />
                    {r.label}
                  </label>
                ))}
              </fieldset>
              <label className="flex flex-col gap-1">
                <span className="text-muted">Anything else we should know (optional)</span>
                <textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, REPORT_NOTE_MAX))} maxLength={REPORT_NOTE_MAX} rows={3}
                  className="rounded-xl border border-grid bg-white px-3 py-2 text-base outline-none focus:border-action" />
              </label>
              {problem && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-danger">{problem}</p>}
              <button type="button" onClick={() => void send()} disabled={!reason || busy} className="rounded-xl bg-action px-4 py-3 font-medium text-white disabled:opacity-50">
                {busy ? "Sending…" : "Send report"}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
