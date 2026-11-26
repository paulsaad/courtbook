import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "./phone";

/**
 * A player's name and contact phone, needed before their first court booking so the club knows who is coming and can
 * reach them (Paul, 26 Nov; the app does the same since #70 — mobile/lib/myProfile.ts holds the same rules and words,
 * and playerDetails.test.ts checks the words are identical). Read and written on the player's own `profiles` row.
 * Nothing is verified: the phone is what the player typed, saved in international form.
 */
export type Field = "name" | "phone";
export type Details = { name: string | null; phone: string | null };

export const NAME_MAX = 80;
export const PHONE_HELP =
  "Clubs use it to reach you about your bookings. For a number outside Lebanon, start with the country code, for example +46 70 123 45 67.";
export const PHONE_PRIVACY = "Only club staff see it, for bookings at their club. We don't verify it.";
export const UNREADABLE = "Couldn't check your details. Check your connection and try again.";

/** What a court booking still needs, in the order the form asks. Only what is missing — a complete profile is never asked again. */
export function missingForBooking(p: Partial<Details> | null | undefined): Field[] {
  const out: Field[] = [];
  if (!p?.name?.trim()) out.push("name");
  if (!p?.phone?.trim()) out.push("phone");
  return out;
}

/** The sentence above the form, by what is asked (the app's wording). */
export function whyWeAsk(ask: Field[]): string {
  return ask.length === 2 ? "The club needs your name and a number to reach you about this booking. We ask once."
    : ask[0] === "name" ? "The club needs your name for this booking. We ask once."
    : "The club needs a number to reach you about this booking. We ask once.";
}

/** The form's check. One sentence per field that needs fixing; `phoneRequired` is false when only editing. */
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

/** What is saved: the name trimmed, the phone in international form (+961…, +46…); an empty phone (editing only) as none. */
export function detailsPatch(v: { name?: string; phone?: string }, ask: Field[]): Partial<Details> {
  const out: Partial<Details> = {};
  if (ask.includes("name")) out.name = (v.name ?? "").trim();
  if (ask.includes("phone")) { const raw = (v.phone ?? "").trim(); out.phone = raw ? normalizePhone(raw) : null; }
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

/** The details step, returning to `next` (a path on this site, e.g. the club page with the selection). */
export function detailsPath(next: string): string {
  return `/details?next=${encodeURIComponent(next)}`;
}

/**
 * Before a court booking: what this signed-in player still has to give, or "unreadable" when their details cannot be
 * read (then nothing is booked and the panel says so). Read fresh at each Reserve, so details filled on another device
 * count at once.
 */
export async function missingBeforeBooking(supabase: SupabaseClient): Promise<Field[] | "unreadable"> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return "unreadable";
    const { data, error } = await supabase.from("profiles").select("name, phone").eq("id", user.id).maybeSingle();
    if (error || !data) return "unreadable";
    return missingForBooking(data as Details);
  } catch {
    return "unreadable";
  }
}
