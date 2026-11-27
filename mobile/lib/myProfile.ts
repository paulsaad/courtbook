import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { normalizePhone } from "@shared/phone";
import { supabase } from "./supabase";
import { gameKeys } from "./games";

/**
 * The player's own details: name and contact phone (needed before the first court booking, so the club knows who is
 * coming and can reach them), and optional sports. Read and written on the player's own `profiles` row — the same
 * columns and the same "update own" permission the website's profile form uses. Levels are per sport, through
 * set_player_level / my_levels, as on the website. Nothing here is verified: the phone is what the player typed.
 */
export type MyProfile = { name: string | null; phone: string | null; sports: string[] };
export type Field = "name" | "phone";

export const myProfileKey = (userId: string | null) => ["my-profile", userId] as const;

export async function fetchMyProfile(userId: string): Promise<MyProfile> {
  const { data, error } = await supabase.from("profiles").select("name, phone, sports").eq("id", userId).maybeSingle();
  if (error) throw error;
  const row = (data ?? {}) as Partial<MyProfile>;
  return { name: row.name ?? null, phone: row.phone ?? null, sports: row.sports ?? [] };
}

export function useMyProfile(userId: string | null) {
  return useQuery({ queryKey: myProfileKey(userId), enabled: !!userId, staleTime: 60_000, queryFn: () => fetchMyProfile(userId!) });
}

/** What a court booking still needs, in the order the form asks. Only what is missing — a complete profile is never asked again. */
export function missingForBooking(p: Pick<MyProfile, "name" | "phone"> | null | undefined): Field[] {
  const out: Field[] = [];
  if (!p?.name?.trim()) out.push("name");
  if (!p?.phone?.trim()) out.push("phone");
  return out;
}

export const NAME_MAX = 80;
export const PHONE_HELP =
  "Clubs use it to reach you about your bookings. For a number outside Lebanon, start with the country code, for example +46 70 123 45 67.";
export const PHONE_PRIVACY = "Only club staff see it, for bookings at their club. We don't verify it.";

/** The form's check. Returns one sentence per field that needs fixing; `phoneRequired` is false when only editing. */
export function checkDetails(v: { name?: string; phone?: string }, ask: Field[], phoneRequired: boolean): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  if (ask.includes("name")) {
    const n = (v.name ?? "").trim();
    if (!n) e.name = "Enter your name, as the club should see it.";
    else if (n.length > NAME_MAX) e.name = `Keep your name under ${NAME_MAX} characters.`;
  }
  if (ask.includes("phone")) {
    const raw = (v.phone ?? "").trim();
    if (!raw) { if (phoneRequired) e.phone = "Enter a phone number the club can reach you on."; }
    else if (!normalizePhone(raw)) e.phone = "That doesn't look like a full phone number. For a number outside Lebanon, start with + and the country code.";
  }
  return e;
}

/**
 * What is saved: the name trimmed, the phone in international form (+961…, +46…) so a club can dial it from anywhere.
 * An empty phone (only possible when editing) is saved as no phone.
 */
export function detailsPatch(v: { name?: string; phone?: string; sports?: string[] }, ask: Field[]): Partial<MyProfile> {
  const out: Partial<MyProfile> = {};
  if (ask.includes("name")) out.name = (v.name ?? "").trim();
  if (ask.includes("phone")) { const raw = (v.phone ?? "").trim(); out.phone = raw ? normalizePhone(raw) : null; }
  if (v.sports) out.sports = v.sports;
  return out;
}

/** A failed save in words. A closed account (0086) cannot change its profile; anything else is the connection or the server. */
export function saveProblem(error: unknown): string {
  const e = (error ?? {}) as { message?: unknown };
  const msg = typeof e.message === "string" ? e.message : "";
  if (/account_closed/.test(msg)) return "This account is closed, so its details can't be changed.";
  if (/network|fetch|timeout|abort|offline/i.test(msg)) return "Not saved. Check your connection and try again.";
  return "Not saved. Something went wrong — try again.";
}

function remember(qc: QueryClient, userId: string, patch: Partial<MyProfile>) {
  qc.setQueryData<MyProfile>(myProfileKey(userId), (old) => ({ name: null, phone: null, sports: [], ...old, ...patch }));
  if (patch.name !== undefined) qc.setQueryData(["profile-name", userId], patch.name);
}

export function useSaveDetails(userId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<MyProfile>) => {
      // .select() makes "no row was changed" visible: an update the permissions filtered out returns nothing
      const { data, error } = await supabase.from("profiles").update(patch).eq("id", userId!).select("id");
      if (error) throw error;
      if (!data || (data as unknown[]).length !== 1) throw Object.assign(new Error("not_saved"), { code: "not_saved" });
      return patch;
    },
    onSuccess: (patch) => { if (userId) remember(qc, userId, patch); },
  });
}

/** One sport's level, 1–10, or null to clear it (set_player_level, as on the website). */
export function useSaveLevel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sport, level }: { sport: string; level: number | null }) => {
      const { error } = await supabase.rpc("set_player_level", { p_sport: sport, p_level: level });
      if (error) throw error;
      return { sport, level };
    },
    onSuccess: ({ sport, level }) => {
      qc.setQueryData<Record<string, number>>(gameKeys.myLevels, (old) => {
        const next = { ...(old ?? {}) };
        if (level == null) delete next[sport]; else next[sport] = level;
        return next;
      });
    },
  });
}
