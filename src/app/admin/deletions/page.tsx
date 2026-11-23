import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loaded } from "@/lib/load";
import WorkNav from "@/components/WorkNav";
import DeletionsBoard, { type Deletion, type Progress } from "./DeletionsBoard";

// M2 (0086): closed accounts still being processed (app, website, or recorded from a support email), with their
// progress and the admin's Retry / Release. Both functions check is_admin() themselves; the role check here only
// decides what the page says.
export default async function AdminDeletions() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/deletions");
  const { data: me } = loaded(await supabase.from("profiles").select("roles").eq("id", user.id).single(), "the deletion requests");
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;
  const [list, progress] = await Promise.all([supabase.rpc("admin_account_deletions"), supabase.rpc("admin_deletion_progress")]);
  // before migration 0086 the progress function does not exist: say so instead of failing
  const missing = !!progress.error && (progress.error.code === "PGRST202" || /admin_deletion_progress/.test(progress.error.message ?? ""));
  const failed = !!list.error || (!!progress.error && !missing);
  return <><WorkNav area="admin" active="deletions" />
    <DeletionsBoard rows={(list.data ?? []) as Deletion[]} progress={(progress.data ?? []) as Progress[]} unavailable={missing} failed={failed} selfId={user.id} /></>;
}
