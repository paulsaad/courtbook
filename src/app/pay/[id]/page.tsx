import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loaded } from "@/lib/load";
import { isMalformedId } from "@/lib/ids";
import PayPanel from "./PayPanel";

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const read = await supabase
    .from("bookings")
    .select("id, status, start_at, end_at, hold_expires_at, price_usd, fee_usd, clubs(name, slug, timezone), courts!bookings_court_id_fkey(name)")
    .eq("id", id)
    .eq("player_id", user.id)
    .single();
  if (isMalformedId(read.error)) notFound();   // a malformed id names no booking (as #78)
  const { data: b } = loaded(read, "this booking");
  if (!b) notFound();
  if (b.status === "confirmed") redirect(`/bookings/${id}`);

  const { data: p } = loaded(await supabase.from("payments").select("id, status, total_usd, provider, kind").eq("booking_id", id).single(), "this payment");
  if (!p) notFound();
  // fee-only (M12.1): what happened to the latest attempt, and how many are left of the three
  const { data: attempts } = p.kind === "fee_only"
    ? loaded(await supabase.from("payment_attempts").select("status, outcome, attempt_no").eq("payment_id", p.id).order("attempt_no", { ascending: false }), "this payment")
    : { data: [] as { status: string; outcome: string | null; attempt_no: number }[] };
  const last = (attempts ?? [])[0] ?? null;

  const club = b.clubs as unknown as { name: string; slug: string; timezone: string };
  const court = b.courts as unknown as { name: string };

  return (
    <PayPanel
      bookingId={b.id}
      paymentId={p.id}
      status={b.status}
      clubName={club.name}
      clubSlug={club.slug}
      timezone={club.timezone}
      courtName={court.name}
      startAt={b.start_at}
      endAt={b.end_at}
      holdExpiresAt={b.hold_expires_at}
      price={Number(b.price_usd)}
      fee={Number(b.fee_usd)}
      total={Number(p.total_usd)}
      feeOnly={p.kind === "fee_only"}
      simulated={p.provider === "simulated"}
      lastAttempt={last ? { status: last.status, outcome: last.outcome } : null}
      attemptsLeft={3 - (attempts ?? []).length}
    />
  );
}
