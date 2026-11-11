"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";
import { GROUP_LABEL, GUIDE, levelGroup } from "@/lib/levels";

/**
 * Pick a level 1–10 for one sport. Ten cards with number, group and description; explicit Save; Clear for a saved level.
 * Nothing is written until Save; a failed save keeps the pending choice.
 */
export default function LevelSheet({ sport, sportName, current, legacy, onClose, onSaved }: {
  sport: string; sportName: string; current: number | null; legacy?: string | null; onClose: () => void; onSaved: (level: number | null) => void;
}) {
  const [pick, setPick] = useState<number | null>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guide = GUIDE[sport];

  async function save(level: number | null) {
    setBusy(true); setError(null);
    const { error } = await createClient().rpc("set_player_level", { p_sport: sport, p_level: level });
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    onSaved(level);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end bg-ink/45" onClick={onClose}>
      <section className="sheet-enter flex max-h-[92vh] w-full flex-col rounded-t-3xl bg-paper shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-3.5">
          <span className="mx-auto mb-3 block h-1 w-11 rounded-full bg-[#d5d8d4]" aria-hidden="true" />
          <div className="flex items-center justify-between">
            <h2 className="text-[22px] font-extrabold tracking-tight">{sportName} level</h2>
            <button onClick={onClose} className="text-sm text-muted">Close</button>
          </div>
          <p className="mt-1 text-sm text-muted">
            {legacy && current == null ? <>You chose <b className="text-ink">{legacy}</b> before — now pick your number. </> : null}
            Choose what you can do consistently in a game. <Link href={`/levels#${sport}`} className="font-semibold text-turf">Help me choose</Link>
          </p>
          {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
        </div>
        <div role="radiogroup" aria-label={`${sportName} level`} className="flex flex-col gap-2 overflow-y-auto px-5 py-3">
          {(guide?.levels ?? Array.from({ length: 10 }, (_, i) => ({ level: i + 1, text: "" }))).map(({ level, text }) => {
            const on = pick === level;
            const g = levelGroup(level)!;
            return (
              <button key={level} role="radio" aria-checked={on} onClick={() => setPick(level)} className={`flex gap-3 rounded-2xl border p-3 text-left ${on ? "border-ink bg-white shadow-[0_0_0_2px_#121614]" : "border-grid bg-white"}`}>
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-extrabold ${on ? "bg-turf text-white" : "bg-turf-soft text-turf"}`}>{level}</span>
                <span className="min-w-0"><span className="block text-[13px] font-bold">{GROUP_LABEL[g]}</span><span className="block text-sm leading-snug text-ink/80">{text}</span></span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-2 border-t border-grid bg-white px-5 pt-3" style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom))" }}>
          <div className="text-center text-sm">{pick ? <>{sportName} · <b>Level {pick}</b> · {GROUP_LABEL[levelGroup(pick)!]}</> : <span className="text-muted">No level selected</span>}</div>
          <button disabled={busy || pick == null || pick === current} onClick={() => save(pick)} className="btn btn-primary">{busy ? "Saving…" : "Save level"}</button>
          <div className="flex justify-between text-sm">
            <button disabled={busy} onClick={() => save(null)} className="py-2 text-muted">{current != null ? "Clear level" : "Not sure yet"}</button>
            <button onClick={onClose} className="py-2 text-muted">Cancel</button>
          </div>
        </div>
      </section>
    </div>
  );
}
