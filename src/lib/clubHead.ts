import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClubHead } from "@/app/club/[slug]/ClubHeader";

/** Header data for the club pages: town, sports (from active courts), price band. */
export async function loadClubHead(supabase: SupabaseClient, club: { id: string; name: string; slug: string; open_time: string; close_time: string; location_url: string | null; town_id: string | null; is_demo?: boolean | null }): Promise<ClubHead> {
  const [{ data: town }, { data: sports }, { data: rules }, { data: sportRows }] = await Promise.all([
    club.town_id ? supabase.from("towns").select("name_en, districts(name_en)").eq("id", club.town_id).single() : Promise.resolve({ data: null }),
    supabase.rpc("club_sports", { p_club: club.id }),
    supabase.from("price_rules").select("price_usd").eq("club_id", club.id),
    supabase.from("sports").select("code, name_en"),
  ]);
  const names = new Map(((sportRows ?? []) as { code: string; name_en: string }[]).map((s) => [s.code, s.name_en]));
  const prices = ((rules ?? []) as { price_usd: number }[]).map((r) => Number(r.price_usd));
  const t = town as unknown as { name_en: string; districts: { name_en: string } | null } | null;
  return {
    name: club.name, slug: club.slug, open_time: club.open_time, close_time: club.close_time, location_url: club.location_url,
    town: t?.name_en ?? null, district: t?.districts?.name_en ?? null,
    sports: ((sports ?? []) as string[]).map((c) => names.get(c) ?? c),
    priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null,
    is_demo: club.is_demo ?? false,
  };
}
