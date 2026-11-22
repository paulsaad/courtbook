"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import { reportBoundary } from "@/lib/report";

/**
 * Shown when a page could not be loaded (website completion W1, audit B2) — instead of an empty list, "not found"
 * or $0. It says only what is known: the page was not loaded. "Try again" reloads this page's data.
 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => reportBoundary(error), [error]);
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6 pt-16 text-center md:max-w-2xl lg:max-w-[720px]">
      <h1 className="text-xl font-semibold">Couldn&apos;t load this page</h1>
      <p className="text-muted">
        CourtBook could not read this page just now, so nothing is shown rather than something that may be wrong.
        Check your connection and try again.
      </p>
      <button type="button" onClick={() => startTransition(() => { router.refresh(); reset(); })}
        className="min-h-11 rounded-xl bg-action px-4 py-3 font-medium text-white">Try again</button>
      <Link href="/" className="py-2 text-sm text-muted underline">Home</Link>
    </main>
  );
}
