"use client";

/**
 * Player discovery filters remembered in this browser. Safe when storage is unavailable.
 * Signed in, the area also lives on the account (0088: last browsing area, saved areas), so it follows the player to
 * other devices; this copy only makes the first paint right and keeps signed-out visitors' choice.
 * `town`/`townName`: a saved area narrowed to a town (the list RPCs filter by district; the town by name).
 */
export type Prefs = { gov: string | null; district: string | null; sport: string | null; town: string | null; townName: string | null };
const KEY = "cb_prefs";
export const EMPTY: Prefs = { gov: null, district: null, sport: null, town: null, townName: null };

export function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    const district = s(p.district);
    const town = district ? s(p.town) : null;
    return { gov: s(p.gov), district, sport: s(p.sport), town, townName: town ? s(p.townName) : null };
  } catch { return EMPTY; }
}
export function writePrefs(p: Prefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} }
