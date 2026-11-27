import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loaded } from "@/lib/load";
import { BLOCKED_PATH, blockedRows } from "@/lib/gameSafety";
import BlockedList from "./BlockedList";

/**
 * Blocked players (M3-S; UX §4.6 "You can unblock them"), as the app's Profile → Blocked players.
 * Only the signed-in player's own list (my_blocked_players): a name per row, nothing else.
 * A failed read is the error page, never "You haven't blocked anyone".
 */
export default async function BlockedPlayersPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${BLOCKED_PATH}`);
  const { data } = loaded(await supabase.rpc("my_blocked_players"), "your blocked players");
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5 pb-24 md:max-w-2xl lg:max-w-[720px]">
      <Link href="/profile" className="text-sm text-muted">‹ Profile</Link>
      <h1 className="text-2xl font-semibold">Blocked players</h1>
      <p className="text-sm text-muted">You don&apos;t see their messages or games, and they can&apos;t join yours. They aren&apos;t told.</p>
      <BlockedList initial={blockedRows(data)} />
    </main>
  );
}
