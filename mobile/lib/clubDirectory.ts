import { useQuery } from "@tanstack/react-query";
import type { Governorate } from "@shared/geo";
import { supabase } from "./supabase";
import { clubPoint, type LatLng } from "./nearby";

/**
 * The club list behind Home's sections: club_discovery(), the same function the website's Home uses
 * (sport, governorate, district, search). Signed-out visitors may browse it (anon can execute it).
 * Coordinates come from a separate read of public club columns, so no database change is needed for
 * distance, and the player's position is never sent anywhere.
 */
export type DirectoryClub = {
  club_id: string; name: string; slug: string; town: string | null; district: string | null; governorate: string | null;
  district_code: string | null; governorate_code: string | null; sports: string[]; price_from: number | null;
  next_free_at: string | null; next_free_court: string | null; next_free_court_id: string | null;
  cover_url: string | null; location_url: string | null; open_time: string; close_time: string; is_demo: boolean;
};
export type DirectoryFilters = { sport: string | null; governorate: string | null; district: string | null; query: string | null };

export const directoryKeys = {
  list: (f: DirectoryFilters) => ["club-directory", f] as const,
  points: ["club-points"] as const,
  areas: ["areas"] as const,
};

export async function fetchDirectory(f: DirectoryFilters): Promise<(DirectoryClub & { id: string })[]> {
  const { data, error } = await supabase.rpc("club_discovery", {
    p_sport: f.sport, p_governorate: f.district ? null : f.governorate, p_district: f.district,
    p_query: f.query && f.query.trim() !== "" ? f.query.trim() : null,
  });
  if (error) throw error;
  return ((data ?? []) as DirectoryClub[]).map((c) => ({ ...c, id: c.club_id }));
}

/** Active clubs' public coordinates; unusable ones are left out (never guessed). */
export async function fetchClubPoints(): Promise<Map<string, LatLng>> {
  const { data, error } = await supabase.from("clubs").select("id, lat, lng").eq("active", true);
  if (error) throw error;
  const out = new Map<string, LatLng>();
  for (const r of (data ?? []) as { id: string; lat: unknown; lng: unknown }[]) {
    const p = clubPoint(r.lat, r.lng);
    if (p) out.set(r.id, p);
  }
  return out;
}

export function useClubDirectory(f: DirectoryFilters) {
  return useQuery({ queryKey: directoryKeys.list(f), staleTime: 30_000, queryFn: () => fetchDirectory(f) });
}

/** Only needed when location is on; coordinates rarely change. */
export function useClubPoints(enabled: boolean) {
  return useQuery({ queryKey: directoryKeys.points, enabled, staleTime: 6 * 3_600_000, queryFn: fetchClubPoints });
}

/** Governorate → district picker (public reference data; the manual fallback to location). */
export function useAreaList() {
  return useQuery({
    queryKey: directoryKeys.areas, staleTime: 24 * 3_600_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("areas");
      if (error) throw error;
      return (data ?? []) as Governorate[];
    },
  });
}
