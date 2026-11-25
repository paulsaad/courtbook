import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { contactFrom } from "./clubInfo";

export { callableClubPhone } from "@shared/clubContactPhone";
import { callableClubPhone } from "@shared/clubContactPhone";

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
