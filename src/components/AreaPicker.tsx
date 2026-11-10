"use client";

import { useState } from "react";
import type { Governorate } from "@/lib/geo";

export type Area = { gov: string | null; district: string | null };

export function areaLabel(areas: Governorate[], a: Area) {
  const g = areas.find((x) => x.code === a.gov);
  if (!g) return "All Lebanon";
  const d = g.districts.find((x) => x.code === a.district);
  return d ? `${d.name_en}, ${g.name_en}` : g.name_en;
}

/** "All Lebanon ▾" button + bottom sheet: governorate, then its districts. */
export default function AreaPicker({ areas, value, onChange }: { areas: Governorate[]; value: Area; onChange: (a: Area) => void }) {
  const [open, setOpen] = useState(false);
  const [gov, setGov] = useState<string | null>(value.gov);
  const g = areas.find((x) => x.code === gov);
  const pick = (a: Area) => { onChange(a); setOpen(false); };
  return (
    <>
      <button onClick={() => { setGov(value.gov); setOpen(true); }} className="flex max-w-[60%] items-center gap-1 truncate text-left text-sm font-medium">
        <span className="text-turf">◉</span><span className="truncate">{areaLabel(areas, value)}</span><span className="text-muted">▾</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-30 flex items-end bg-ink/40" onClick={() => setOpen(false)}>
          <div className="sheet-enter max-h-[80vh] w-full overflow-y-auto rounded-t-3xl bg-paper p-5 pb-8" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{g ? g.name_en : "Where do you want to play?"}</h2>
              {g ? <button onClick={() => setGov(null)} className="text-sm text-action">‹ Governorates</button> : <button onClick={() => setOpen(false)} className="text-sm text-muted">Close</button>}
            </div>
            <ul className="divide-y divide-grid overflow-hidden rounded-2xl border border-grid bg-white">
              {!g && <li><button onClick={() => pick({ gov: null, district: null })} className="w-full px-4 py-3.5 text-left font-medium">All Lebanon</button></li>}
              {!g && areas.map((x) => (
                <li key={x.code}><button onClick={() => setGov(x.code)} className="flex w-full items-center justify-between px-4 py-3.5 text-left"><span>{x.name_en}</span><span className="text-muted">›</span></button></li>
              ))}
              {g && <li><button onClick={() => pick({ gov: g.code, district: null })} className="w-full px-4 py-3.5 text-left font-medium">All of {g.name_en}</button></li>}
              {g && g.districts.map((d) => (
                <li key={d.code}><button onClick={() => pick({ gov: g.code, district: d.code })} className="w-full px-4 py-3.5 text-left">{d.name_en}</button></li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
