import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * M2: processes one account-deletion request (manual at launch: an admin presses "Delete" on /admin/deletions).
 *
 *   1. delete_account_data — called with the ADMIN's own session, so the database decides who may (is_admin) and
 *      which requests may go ahead (staff/admin role, legal hold, coach bookings). One transaction: cancels, anonymises,
 *      deletes messages. Re-running after it succeeded is a no-op.
 *   2. Supabase Auth: delete the sign-in account (service key; the only step the database cannot do). This removes the
 *      profile; every remaining reference becomes null. "User not found" means a previous run got this far: go on.
 *   3. finish_account_deletion — the admin's session again; refuses unless the profile is really gone.
 *
 * If step 2 or 3 fails the request stays "data_removed" and pressing Delete again resumes it. Nothing about the person
 * is logged: the response carries only step names and database error codes.
 */
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function POST(request: Request) {
  let subject: unknown;
  try { subject = ((await request.json()) as { subject?: unknown }).subject; } catch { subject = null; }
  if (typeof subject !== "string" || !UUID.test(subject)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });
  if (user.id === subject) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const step1 = await supabase.rpc("delete_account_data", { p_subject: subject });
  if (step1.error) {
    const code = step1.error.message?.match(/^[a-z_]+$/)?.[0] ?? "data_step_failed";
    return NextResponse.json({ error: code, step: "data" }, { status: code === "forbidden" ? 403 : 409 });
  }

  const del = await createAdminClient().auth.admin.deleteUser(subject);
  if (del.error && !/not.?found/i.test(del.error.message ?? "") && del.error.status !== 404) {
    return NextResponse.json({ error: "auth_step_failed", step: "auth" }, { status: 502 });
  }

  const step3 = await supabase.rpc("finish_account_deletion", { p_subject: subject });
  if (step3.error) {
    const code = step3.error.message?.match(/^[a-z_]+$/)?.[0] ?? "finish_step_failed";
    return NextResponse.json({ error: code, step: "finish" }, { status: 409 });
  }
  return NextResponse.json({ ok: true, summary: step1.data ?? null });
}
