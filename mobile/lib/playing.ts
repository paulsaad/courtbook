import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { areasPayload, parsePlayingPrefs, type PlayingArea, type PlayingPrefs } from "@shared/places";
import { supabase } from "./supabase";

/**
 * Saved playing areas and the last browsing area, on the account (0088), so a player who plays in Beirut in the week
 * and Batroun at the weekend finds both on any device. `null` data = the server does not have 0088 yet: the screens
 * then behave exactly as before (no chips, no question). Nothing here is a position.
 */
export const playingKeys = { mine: (userId: string) => ["playing-prefs", userId] as const };

const missingFunction = (e: unknown) => {
  const x = e as { code?: unknown; message?: unknown } | null;
  return !!x && (x.code === "PGRST202" || (typeof x.message === "string" && /could not find the function/i.test(x.message)));
};

export async function fetchPlaying(): Promise<PlayingPrefs | null> {
  const { data, error } = await supabase.rpc("my_playing_prefs");
  if (error) { if (missingFunction(error)) return null; throw error; }
  return parsePlayingPrefs(data);
}

export function usePlayingPrefs(userId: string | null) {
  return useQuery({ queryKey: playingKeys.mine(userId ?? ""), enabled: !!userId, staleTime: 5 * 60_000, queryFn: fetchPlaying });
}

/** Replace the saved list (in order). Rejects with a short code ("too_many_areas", "bad_area", …). */
export function useSaveAreas(userId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (areas: PlayingArea[]) => {
      const { data, error } = await supabase.rpc("set_playing_areas", { p_areas: areasPayload(areas) });
      if (error) throw new Error(typeof error.message === "string" && /^[a-z_]+$/.test(error.message) ? error.message : "failed");
      return parsePlayingPrefs(data);
    },
    onSuccess: (next) => { if (userId) qc.setQueryData(playingKeys.mine(userId), next); },
  });
}

/** "Not now" on the first-use question: never asked again, on any device. The question is hidden only once the
 *  account has recorded it (M14 review C); a failure rejects with a short code and leaves it showing. */
export function useDismissQuestion(userId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!userId) throw new Error("not_authenticated");
      let error: { message?: unknown } | null = null;
      try { ({ error } = await supabase.rpc("dismiss_areas_question")); }
      catch { error = { message: "failed" }; }
      if (error) throw new Error(typeof error.message === "string" && /^[a-z_]+$/.test(error.message) ? error.message : "failed");
    },
    onSuccess: () => { if (userId) qc.setQueryData<PlayingPrefs | null>(playingKeys.mine(userId), (p) => (p ? { ...p, asked: true } : p)); },
  });
}

/** Remember the area being browsed (best effort; the screen keeps working if it fails). Also updates this device's
 *  copy of the account's prefs at once, so the Courts tab, when it opens again before the prefs are re-read, opens on
 *  the area the player chose last and not on an older one (staging, 28 Nov: an older "North" came back). */
export function useRememberArea(userId: string | null): (a: PlayingArea | null) => void {
  const qc = useQueryClient();
  return (a: PlayingArea | null) => {
    if (userId) qc.setQueryData<PlayingPrefs | null>(playingKeys.mine(userId), (p) => (p ? { ...p, last: a } : p));
    rememberArea(a);
  };
}

export function rememberArea(a: PlayingArea | null): void {
  void Promise.resolve(supabase.rpc("set_last_area", { p_governorate: a?.governorate ?? null, p_district: a?.district ?? null, p_town: a?.district ? a.town : null }))
    .catch(() => {});
}
