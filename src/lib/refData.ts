import type { SupabaseClient } from "@supabase/supabase-js";
import type { Governorate, Sport, Town } from "./geo";
import { allLoaded, loaded } from "./load";

/**
 * Website versions of `geo.ts`'s loaders that never pass off a failed read as an empty list (W1, audit B2): a
 * failure throws and the page shows "Couldn't load this page". `geo.ts` is shared byte-for-byte with the mobile
 * app and is left exactly as it is; the queries here are the same.
 */
export async function loadRefDataChecked(supabase: SupabaseClient): Promise<{ areas: Governorate[]; sports: Sport[] }> {
  const [{ data: areas }, { data: sports }] = allLoaded(await Promise.all([
    supabase.rpc("areas"),
    supabase.from("sports").select("*").eq("active", true).order("name_en"),
  ]), "the areas and sports");
  return { areas: (areas ?? []) as Governorate[], sports: (sports ?? []) as Sport[] };
}

/** Town with its district and governorate codes, for pre-selecting the pickers. */
export async function loadTownChecked(supabase: SupabaseClient, townId: string | null) {
  if (!townId) return null;
  const { data } = loaded(await supabase.from("towns").select("id, district_code, name_en, name_ar, districts(governorate_code)").eq("id", townId).single(), "the club's town");
  if (!data) return null;
  const d = data as unknown as Town & { districts: { governorate_code: string } | null };
  return { id: d.id, district_code: d.district_code, name_en: d.name_en, name_ar: d.name_ar, governorate_code: d.districts?.governorate_code ?? "" };
}
