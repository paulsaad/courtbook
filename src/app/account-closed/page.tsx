import Link from "next/link";
import { CLOSED_TITLE, CLOSED_TEXT } from "@/lib/deletion/copy";

export const metadata = { title: "Your account is closed · CourtBook" };

/**
 * M2 (0086): shown after "Delete my account" (D5). The person is already signed out. It never says the data has been
 * deleted: processing may still be running, may be retried later, or (held accounts) waits for a review.
 */
export default function AccountClosed() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-4 p-5 pt-16">
      <h1 className="text-[28px] font-extrabold tracking-tight">{CLOSED_TITLE}</h1>
      <p className="text-sm">{CLOSED_TEXT}</p>
      <p className="text-sm text-muted">
        Questions? See <Link href="/delete-account" className="font-semibold text-turf">what happens to your data</Link>.
      </p>
      <Link href="/" className="btn btn-secondary self-start">Back to CourtBook</Link>
    </main>
  );
}
