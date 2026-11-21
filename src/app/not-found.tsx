import Link from "next/link";

/** "Not found" after a successful read that found nothing (W1, audit B2). A failed read shows error.tsx instead. */
export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6 pt-16 text-center md:max-w-2xl lg:max-w-[720px]">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-muted">This page does not exist, or it is not available to your account.</p>
      <Link href="/" className="min-h-11 rounded-xl bg-action px-4 py-3 font-medium text-white">Home</Link>
    </main>
  );
}
