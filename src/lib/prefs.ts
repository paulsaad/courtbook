"use client";

/** Player discovery filters, remembered on this phone. Safe when storage is unavailable. */
export type Prefs = { gov: string | null; district: string | null; sport: string | null };
const KEY = "cb_prefs";
export const EMPTY: Prefs = { gov: null, district: null, sport: null };

export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { gov: p.gov ?? null, district: p.district ?? null, sport: p.sport ?? null };
  } catch { return EMPTY; }
}
export function writePrefs(p: Prefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} }
