import type { SupabaseClient } from "@supabase/supabase-js";

export type District = { code: string; name_en: string; name_ar: string };
export type Governorate = { code: string; name_en: string; name_ar: string; districts: District[] };
export type Town = { id: string; district_code: string; name_en: string; name_ar: string | null };
export type Sport = { code: string; name_en: string; name_ar: string; sort_order: number; active: boolean };

/** Governorates → districts (one RPC) and the sports table. Read-only reference data. */
export async function loadRefData(supabase: SupabaseClient): Promise<{ areas: Governorate[]; sports: Sport[] }> {
  const [{ data: areas }, { data: sports }] = await Promise.all([
    supabase.rpc("areas"),
    supabase.from("sports").select("*").eq("active", true).order("sort_order"),
  ]);
  return { areas: (areas ?? []) as Governorate[], sports: (sports ?? []) as Sport[] };
}

/** Town with its district and governorate codes, for pre-selecting the pickers. */
export async function loadTown(supabase: SupabaseClient, townId: string | null) {
  if (!townId) return null;
  const { data } = await supabase.from("towns").select("id, district_code, name_en, name_ar, districts(governorate_code)").eq("id", townId).single();
  if (!data) return null;
  const d = data as unknown as Town & { districts: { governorate_code: string } | null };
  return { id: d.id, district_code: d.district_code, name_en: d.name_en, name_ar: d.name_ar, governorate_code: d.districts?.governorate_code ?? "" };
}

export type TownWithArea = NonNullable<Awaited<ReturnType<typeof loadTown>>>;
