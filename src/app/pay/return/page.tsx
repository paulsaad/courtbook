import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { report } from "@/lib/report";
import { providerNamed } from "@/lib/payments";
import { verifyAndRecord } from "@/lib/payments/attempts";
import { isUuid } from "@/lib/payments/urls";

/**
 * Where the provider sends the player back (M12.1). The redirect itself proves nothing: the server asks the provider
 * about the attempt and records the answer (the same idempotent path as the callback), then shows the booking if it
 * is confirmed, or the payment page with what happened.
 */
export default async function PayReturn({ searchParams }: { searchParams: Promise<{ attempt?: string }> }) {
  const { attempt } = await searchParams;
  if (!isUuid(attempt)) notFound();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/pay/return?attempt=${attempt}`)}`);

  // RLS: a player reads only their own attempts
  const { data: a } = await supabase.from("payment_attempts").select("id, status, provider, payments!inner(booking_id)").eq("id", attempt).maybeSingle();
  if (!a) notFound();
  const bookingId = (a.payments as unknown as { booking_id: string }).booking_id;

  if (a.status === "starting" || a.status === "open") {
    const provider = providerNamed(a.provider);
    if (provider) {
      const r = await verifyAndRecord(createAdminClient(), provider, a.id);
      if (!r.ok && r.code !== "attempt_not_found") await report(r.code === "provider_unavailable" ? "paymentProvider" : "paymentRecord", "payment", { code: r.code });
    }
  }
  const { data: b } = await supabase.from("bookings").select("status").eq("id", bookingId).single();
  if (b?.status === "confirmed") redirect(`/bookings/${bookingId}?new=1`);
  redirect(`/pay/${bookingId}?attempt=${a.id}`);
}
