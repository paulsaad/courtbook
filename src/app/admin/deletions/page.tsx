import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loaded } from "@/lib/load";
import WorkNav from "@/components/WorkNav";
import DeletionsBoard, { type Deletion } from "./DeletionsBoard";

// M2: open account-deletion requests (app, website, or recorded from a support email) and the Delete button.
// admin_account_deletions checks is_admin() itself; the role check here only decides what the page says.
export default async function AdminDeletions() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/deletions");
  const { data: me } = loaded(await supabase.from("profiles").select("roles").eq("id", user.id).single(), "the deletion requests");
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;
  const { data, error } = await supabase.rpc("admin_account_deletions");
  // before migration 0079 the function does not exist: say so instead of failing
  const missing = !!error && (error.code === "PGRST202" || /admin_account_deletions/.test(error.message ?? ""));
  return <><WorkNav area="admin" active="deletions" /><DeletionsBoard rows={(data ?? []) as Deletion[]} unavailable={missing} failed={!!error && !missing} /></>;
}
