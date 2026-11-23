import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { isMissingFunction } from "./safety";

/**
 * 18+ (0080). Asked once, before player activity. Kept: the answer and when it was given (nothing else).
 * "unknown" = not asked: before 0080 exists, offline, or a server problem — the app never blocks on a failed read;
 * the database enforces the rule itself, and the question appears once the status can be read.
 */
export type AgeState = "confirmed" | "needed" | "unknown";
export const ageKey = ["age-status"] as const;
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
const defaultRpc: Rpc = (fn, args) => supabase.rpc(fn, args);

export async function fetchAgeState(rpc: Rpc = defaultRpc): Promise<AgeState> {
  const { data, error } = await rpc("my_age_status", {});
  if (error) { if (isMissingFunction(error)) return "confirmed"; throw error; }
  const s = data as { confirmed?: boolean } | null;
  return s?.confirmed === false ? "needed" : "confirmed";
}

export function useAgeState(signedIn: boolean): AgeState {
  const q = useQuery({ queryKey: ageKey, enabled: signedIn, staleTime: Infinity, retry: 1, queryFn: () => fetchAgeState() });
  return signedIn && q.data ? q.data : "unknown";
}

/** Confirms; returns an error message for the person, or null. */
export async function confirmAge(rpc: Rpc = defaultRpc): Promise<string | null> {
  const { error } = await rpc("confirm_age", { p_is_18_or_over: true, p_via: "app" });
  return error ? "That didn't work. Check your connection and try again." : null;
}

export function useConfirmAge() {
  const qc = useQueryClient();
  return async () => {
    const problem = await confirmAge();
    if (!problem) qc.setQueryData(ageKey, "confirmed" satisfies AgeState);
    return problem;
  };
}
