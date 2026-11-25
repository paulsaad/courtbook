import type { Metadata } from "next";
import { appReturnLink } from "@/lib/payments/appReturn";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Back to CourtBook", robots: { index: false, follow: false } };

/**
 * Where the payment provider sends a player who paid from the app (M12.4). It reads nothing, records nothing and
 * shows no payment details — anyone can open it. Its only job is to hand control back to the app, which then asks
 * the server where the payment stands; arriving here is not proof of anything.
 */
export default function AppReturn() {
  const link = appReturnLink();
  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col items-center gap-4 p-5 pt-16 text-center">
      {link && <meta httpEquiv="refresh" content={`0;url=${link}`} />}
      <h1 className="text-xl font-semibold">Back to CourtBook</h1>
      <p className="text-neutral-700">
        Return to the CourtBook app. It will check with the payment provider whether your payment went through.
      </p>
      {link ? (
        <a href={link} className="inline-block rounded-lg bg-emerald-700 px-5 py-3 font-medium text-white">Open the CourtBook app</a>
      ) : (
        <p className="text-neutral-700">You can close this page.</p>
      )}
    </main>
  );
}
