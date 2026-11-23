"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { areasPayload, parsePlayingPrefs, type PlayingArea, type PlayingPrefs } from "@/lib/places";
import type { Prefs } from "@/lib/prefs";

/**
 * Saved playing areas and the last browsing area, on the account (0088). `prefs` is null while loading, when signed
 * out, or when the database does not have 0088 yet (the screens then behave exactly as before).
 */
const missingFunction = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST202" || /could not find the function/i.test(e.message ?? ""));

export function usePlaying(signedIn: boolean) {
  const [prefs, setPrefs] = useState<PlayingPrefs | null>(null);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    createClient().rpc("my_playing_prefs").then(({ data, error }) => {
      if (!alive) return;
      if (error) { setAvailable(!missingFunction(error)); return; }   // a failed read leaves the screens as they were
      setAvailable(true);
      setPrefs(parsePlayingPrefs(data));
    });
    return () => { alive = false; };
  }, [signedIn]);

  /** Replace the saved list (in order). Throws a short code on refusal. */
  const saveAreas = useCallback(async (areas: PlayingArea[]) => {
    const { data, error } = await createClient().rpc("set_playing_areas", { p_areas: areasPayload(areas) });
    if (error) throw new Error(/^[a-z_]+$/.test(error.message ?? "") ? error.message : "failed");
    const next = parsePlayingPrefs(data);
    setPrefs(next);
    return next;
  }, []);
  const dismissQuestion = useCallback(async () => {
    setPrefs((p) => (p ? { ...p, asked: true } : p));
    await createClient().rpc("dismiss_areas_question");
  }, []);
  /** Remember the area being browsed; best effort (the browser keeps its own copy). */
  const rememberArea = useCallback((p: Pick<Prefs, "gov" | "district" | "town">) => {
    if (!signedIn || !available) return;
    void createClient().rpc("set_last_area", { p_governorate: p.gov, p_district: p.gov ? p.district : null, p_town: p.gov && p.district ? p.town : null });
  }, [signedIn, available]);
  return { prefs, available, saveAreas, dismissQuestion, rememberArea };
}

/** An area as the filters hold it. */
export function prefsFromArea(a: PlayingArea | null): Pick<Prefs, "gov" | "district" | "town" | "townName"> {
  if (!a) return { gov: null, district: null, town: null, townName: null };
  return { gov: a.governorate, district: a.district, town: a.district ? a.town : null, townName: a.district && a.town ? a.label ?? null : null };
}
export function areaFromPrefs(p: Pick<Prefs, "gov" | "district" | "town">): PlayingArea | null {
  return p.gov ? { governorate: p.gov, district: p.district, town: p.district ? p.town : null } : null;
}
