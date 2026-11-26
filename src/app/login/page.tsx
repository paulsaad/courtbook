import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/safeNext";
import LoginForm from "./LoginForm";

/**
 * Sign-in. A player who is already signed in goes straight on to where they were heading (the same safe
 * `next` the form would use). Local pilot build, 26 Nov: a signed-in player who reached /login — e.g. via
 * "Sign in to reserve" on a page opened before signing in elsewhere — was asked to sign in again and could
 * request a needless code.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect(safeNextPath(Array.isArray(next) ? next[0] : next));
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}
