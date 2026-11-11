"use client";

import Link from "next/link";
import { rangeLabel } from "@/lib/levels";

/** "All levels welcome" or a min–max range with steppers. Value: [null,null] = all. */
export default function LevelRange({ value, onChange }: { value: [number | null, number | null]; onChange: (v: [number | null, number | null]) => void }) {
  const [min, max] = value;
  const all = min == null;
  const step = (which: 0 | 1, d: number) => {
    const m = [min ?? 4, max ?? 6] as [number, number];
    m[which] = Math.min(10, Math.max(1, m[which] + d));
    if (which === 0 && m[0] > m[1]) m[1] = m[0];
    if (which === 1 && m[1] < m[0]) m[0] = m[1];
    onChange(m);
  };
  const btn = "flex h-10 w-10 items-center justify-center rounded-full border border-grid bg-white text-lg font-bold disabled:opacity-40";
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex gap-2">
        <button type="button" onClick={() => onChange([null, null])} className={`chip ${all ? "chip-on" : ""}`}>All levels welcome</button>
        <button type="button" onClick={() => { if (all) onChange([4, 6]); }} className={`chip ${!all ? "chip-on" : ""}`}>Level range</button>
      </div>
      {!all && (
        <div className="flex items-center justify-between rounded-2xl border border-grid bg-white px-3 py-2">
          <div className="flex items-center gap-2"><span className="text-xs text-muted">Min</span><button type="button" aria-label="Lower minimum" disabled={min! <= 1} onClick={() => step(0, -1)} className={btn}>−</button><b className="w-6 text-center text-lg">{min}</b><button type="button" aria-label="Raise minimum" disabled={min! >= 10} onClick={() => step(0, 1)} className={btn}>+</button></div>
          <div className="flex items-center gap-2"><span className="text-xs text-muted">Max</span><button type="button" aria-label="Lower maximum" disabled={max! <= 1} onClick={() => step(1, -1)} className={btn}>−</button><b className="w-6 text-center text-lg">{max}</b><button type="button" aria-label="Raise maximum" disabled={max! >= 10} onClick={() => step(1, 1)} className={btn}>+</button></div>
        </div>
      )}
      <div className="flex items-center justify-between"><b>{rangeLabel(min, max)}</b><Link href="/levels" className="text-turf">What do levels mean?</Link></div>
    </div>
  );
}
