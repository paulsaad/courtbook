import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";

/** The signed-in player's display name, or null. First word only is used for greetings. */
export function useProfileName(userId: string | null) {
  return useQuery({
    queryKey: ["profile-name", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("name").eq("id", userId!).maybeSingle();
      if (error) throw error;
      return ((data as { name: string | null } | null)?.name ?? null);
    },
  });
}

export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}
