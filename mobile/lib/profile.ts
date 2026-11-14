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

/** "Paul Saad" → "PS"; "paul.saad@…" → "PS"; one word → its first letter. */
export function initials(s: string | null): string {
  const words = (s ?? "").split("@")[0].trim().split(/[\s._-]+/).filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words[words.length - 1]] : words.slice(0, 1)).map((w) => w[0]!.toUpperCase());
  return letters.join("") || "?";
}
