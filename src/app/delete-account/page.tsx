import Link from "next/link";
import { LegalLinks, Pending } from "@/components/legal";
import { CONTACT_EMAIL } from "@/lib/legal";

export const metadata = { title: "Delete your CourtBook account" };

/**
 * M2: the public page app stores link to ("how to delete your account and data"). Works without signing in, for
 * people who no longer have the app.
 * LAUNCH REQUIREMENTS (master checklist M2): (1) the processing time and the retention wording below are provisional
 * until the legal review (L6) and are shown marked (Pending) until then; (2) no confirmation email is sent yet (needs the CourtBook sender, M5) — do not promise
 * one here until it exists.
 */
const CONTACT = CONTACT_EMAIL;

export default function DeleteAccountInfo() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-5 p-5 pt-12">
      <Link href="/" className="text-sm text-muted">‹ CourtBook</Link>
      <h1 className="text-[28px] font-extrabold tracking-tight">Delete your CourtBook account</h1>

      <section className="card p-4">
        <h2 className="font-bold">In the app or on the website</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
          <li>Sign in with the email address on your account.</li>
          <li>Open <b>Profile</b> and choose <b>Delete my account</b>.</li>
          <li>Confirm. You can cancel the request until it is processed.</li>
        </ol>
        <p className="mt-3 text-sm"><Link href="/profile" className="font-semibold text-turf">Go to your profile</Link></p>
      </section>

      <section className="card p-4">
        <h2 className="font-bold">Without the app</h2>
        <p className="mt-2 text-sm">
          Email <a href={`mailto:${CONTACT}?subject=Delete%20my%20CourtBook%20account`} className="font-semibold text-turf">{CONTACT}</a> from
          the email address on your account, with the subject “Delete my CourtBook account”. We may ask you to confirm with
          a code sent to that address, so that nobody else can delete your account.
        </p>
      </section>

      <section className="card p-4">
        <h2 className="font-bold">What happens</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li><Pending kind="legal">We aim to process requests within 30 days.</Pending> Once your account is deleted, signing in with your email starts a new, empty account.</li>
          <li><b>Deleted:</b> your name, phone number, email sign-in, playing levels and sports, coach profile, chat messages,
            notifications and blocked-player list. You are taken out of the games you joined.</li>
          <li><b>Cancelled:</b> your upcoming bookings, under the club’s normal cancellation rules, and the games you organise
            (their players are told).</li>
          <li><b>Kept without your name:</b> past bookings and payments, because clubs and CourtBook must keep them for their
            accounts <Pending kind="legal">for the period the law requires</Pending>; refunds already owed to you are still paid.</li>
          <li><b>Kept for safety:</b> reports about content or players, as required to handle abuse, then cleared on schedule.</li>
        </ul>
      </section>
      <p className="text-sm text-muted">Club staff and admins: ask the club (or CourtBook) to remove your role first.</p>
      <LegalLinks current="/delete-account" />
    </main>
  );
}
