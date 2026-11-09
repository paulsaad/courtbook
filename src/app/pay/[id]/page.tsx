import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PayPanel from "./PayPanel";

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: b } = await supabase
    .from("bookings")
    .select("id, status, start_at, end_at, hold_expires_at, price_usd, fee_usd, clubs(name, slug, timezone), courts!bookings_court_id_fkey(name)")
    .eq("id", id)
    .eq("player_id", user.id)
    .single();
  if (!b) notFound();
  if (b.status === "confirmed") redirect(`/bookings/${id}`);

  const { data: p } = await supabase.from("payments").select("id, status, total_usd, provider").eq("booking_id", id).single();
  if (!p) notFound();

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
    />
  );
}
