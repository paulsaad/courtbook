import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { contactFrom } from "./clubInfo";

/**
 * PR-9b: the number a player may call about a booking. Only the club's own public contact phone (clubs.contact_phone:
 * set by the club in its settings, required before the club is published, already shown on the club's Info tab).
 * Never a person's number: no staff profile phone is read. A value that is not a plain phone number is not dialled.
 *
 * Returns what to put after "tel:" (digits, with a leading + if it had one), or null.
 */
export function callableClubPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (/[^0-9+\s\-().]/.test(t)) return null;                 // letters, extensions, anything else: not dialled
  const plus = t.indexOf("+");
  if (plus > 0 || t.lastIndexOf("+") !== plus) return null;  // a + only at the very start, once
  const digits = t.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;  // shortest Lebanese number (7 digits) .. E.164 maximum
  return (plus === 0 ? "+" : "") + digits;
}

/** The club's callable phone: a number, null (none, or not callable), or an error/loading state from the query. */
export function useClubPhone(clubId: string | null | undefined) {
  return useQuery({
    queryKey: ["club-phone", clubId],
    enabled: !!clubId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const contact = contactFrom(await supabase.from("clubs").select("contact_phone, contact_email").eq("id", clubId!).single());
      return callableClubPhone(contact?.contact_phone);
    },
  });
}
