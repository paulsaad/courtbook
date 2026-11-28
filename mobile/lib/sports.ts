import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { sportName } from "./days";

/**
 * The sports catalogue (admin-managed, F15): which sports players can choose, by display name, alphabetically (F16).
 * Loaded from the `sports` table (active only). Until it has loaded, or if it cannot load, the sports this app version
 * knows are shown, so the filters never flash empty. A sport added later appears without an app update; its mark is the
 * neutral "other" mark until a build draws one (components/SportMark.tsx).
 */
export type CatalogueSport = { code: string; name: string };

// Only sports active everywhere. Table tennis is left out (I-7, #108 review): it starts inactive (0100) and appears from
// the catalogue once an admin activates it, so an app that cannot read the catalogue never offers it early.
export const KNOWN_SPORTS: CatalogueSport[] = sortByName(
  ["padel", "tennis", "football", "basketball", "volleyball", "squash", "badminton"].map((code) => ({ code, name: sportName(code) })),
);

export function sortByName(list: CatalogueSport[]): CatalogueSport[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** Rows from the table → the chips: active only, "other" left out of choice lists, alphabetical by name. */
export function choosable(rows: { code: string; name_en: string | null; active?: boolean | null }[] | null | undefined): CatalogueSport[] {
  if (!rows?.length) return KNOWN_SPORTS;
  return sortByName(rows.filter((r) => r.active !== false && r.code !== "other").map((r) => ({ code: r.code, name: r.name_en?.trim() || sportName(r.code) })));
}

export const sportsKey = ["sports-catalogue"] as const;

export function useSports() {
  const q = useQuery({
    queryKey: sportsKey,
    staleTime: 6 * 60 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase.from("sports").select("code, name_en, active").eq("active", true).order("name_en");
      if (error) throw new Error("sports");
      return choosable(data as { code: string; name_en: string; active: boolean }[]);
    },
  });
  return q.data ?? KNOWN_SPORTS;
}

/** The catalogue's name for a code, else a readable fallback. */
export function nameOf(code: string, list: CatalogueSport[]): string {
  return list.find((s) => s.code === code)?.name ?? sportName(code);
}
