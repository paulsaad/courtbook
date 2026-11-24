import { Alert, Linking, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";
import { hhmm } from "@shared/time";
import { Text } from "../../components/Text";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Ticket, TicketRow } from "../../components/Ticket";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { useSession } from "../../lib/session";
import { cancellation, useBooking, usePayment } from "../../lib/bookings";
import { directionsUrl } from "@shared/places";
import { money } from "../../lib/queries";
import { durationLabel } from "../../lib/courts";
import { sportName } from "../../lib/days";
import { useCancellation } from "../../lib/cancel";
import { GAME_WRITES_AVAILABLE } from "../../lib/gameActions";
import { feeCancelNote, feeLine } from "../../lib/feePayment";
import { color, font, radius, space } from "../../lib/theme";

/**
 * One of the player's bookings: the confirmation right after reserving (?new=1) and the detail
 * screen from Bookings or a notification. Everything shown is read back from the database — the
 * price is the one stored on the booking, the cancellation terms are the club's own cutoff, and
 * cancelling goes through cancel_booking, which decides any refund. Wording matches the website.
 */
export default function Booking() {
  const p = useLocalSearchParams<{ id: string; new?: string }>();
  const session = useSession();
  const insets = useSafeAreaInsets();
  const signedIn = session.status === "signed-in";
  const q = useBooking(signedIn ? p.id : undefined);
  const b = q.data;
  const atDesk = b?.club.payment_mode === "at_desk";
  const pay = usePayment(signedIn && b && !atDesk ? b.id : undefined);
  // M12.1/M12.4 Model 2: the court is paid at the club and only the CourtBook fee online ('fee_only'). A fee_online
  // booking with a $0 fee has no payment row at all and is shown like a desk booking. Model 1 (court and fee online,
  // demo clubs) is unchanged.
  const feeOnly = !atDesk && pay.data?.kind === "fee_only";
  const deskLike = atDesk || (b?.club.payment_mode === "fee_online" && pay.isSuccess && !pay.data);
  // until the payment row is read, nothing about money is claimed (never "Paid" for an unknown status)
  const payKnown = atDesk || pay.isSuccess;
  const queryClient = useQueryClient();
  const cancel = useCancellation({
    bookingId: p.id,
    read: async () => {
      void queryClient.invalidateQueries({ queryKey: ["my-agenda"] });
      void queryClient.invalidateQueries({ queryKey: ["day-slots"] });
      const r = await q.refetch();
      return r.isError ? "unreachable" : r.data?.status ?? null;
    },
  });

  if (session.status === "loading") return <Loading label="Checking sign-in" />;
  if (!signedIn) return <SignInPrompt title="Sign in to see this booking" body="Your bookings are only shown to you." />;
  if (q.isPending) return <Loading label="Loading your booking" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!b) return <Empty title="Booking not found" body="It isn't one of your bookings." action="Go to Bookings" onAction={() => router.dismissTo("/bookings")} />;

  const tz = b.club.timezone;
  const minutes = Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60_000);
  const { cutoffAt, free } = cancellation(b.start_at, b.club.cancel_cutoff_hours);
  const directions = directionsUrl(b.club.lat, b.club.lng, b.club.location_url);   // the exact point when there is one
  const freeCancel = b.status === "confirmed" && free;
  const upcoming = b.status === "confirmed" && Date.parse(b.end_at) > Date.now();
  const cutoffLabel = formatInTimeZone(cutoffAt, tz, "EEE d MMM HH:mm");
  const isNew = p.new === "1" && b.status === "confirmed";
  const price = Number(b.price_usd ?? 0);
  const fee = Number(b.fee_usd ?? 0);

  function confirmCancel() {
    const msg = deskLike
      ? freeCancel ? "Nothing was paid through CourtBook, so there is nothing to refund." : "This is inside the cutoff — the club is expecting you, so let them know."
      : feeOnly
        ? `${freeCancel ? "The court was never paid through CourtBook." : "This is inside the cutoff — the club is expecting you, so let them know."} ${feeCancelNote(pay.data?.status, fee)}`
      : freeCancel ? "You will be refunded in full." : "This is inside the cutoff: the payment is not refunded.";
    Alert.alert("Cancel this booking?", msg, [
      { text: "Keep it", style: "cancel" },
      { text: "Yes, cancel", style: "destructive", onPress: () => void cancel.submit() },
    ]);
  }

  const statusLine =
    b.status === "cancelled" ? "Cancelled" : b.status === "no_show" ? "Marked as a no-show" : b.status === "pending" ? "Waiting for payment" : null;

  return (
    // The last line must clear the phone's navigation bar (Android draws the app behind it).
    <ScrollView style={styles.page} contentContainerStyle={[styles.content, { paddingBottom: 48 + insets.bottom }]}>
      <Stack.Screen options={{ title: isNew ? "" : "Booking", headerBackVisible: !isNew, gestureEnabled: !isNew }} />
      {isNew && (
        <View style={styles.hero} accessibilityRole="header">
          <View style={styles.tick}><Icon name="check" size={28} color={color.onDark} strokeWidth={2.6} /></View>
          <Text variant="title">Court booked</Text>
          <Text variant="secondary">
            {deskLike ? `Reservation confirmed. Pay ${money(price)} at the club.`
              : feeOnly ? `Booking fee paid. Pay ${money(price)} at the club.`
              : payKnown ? "Booked and paid." : "Reservation confirmed."}
          </Text>
        </View>
      )}

      <Ticket
        date={formatInTimeZone(new Date(b.start_at), tz, "EEEE d MMMM")}
        start={hhmm(b.start_at, tz)}
        end={hhmm(b.end_at, tz)}
        sport={b.court ? { key: b.court.sport, label: sportName(b.court.sport) } : undefined}
      >
        <TicketRow label="Club" value={b.club.name} />
        <TicketRow label="Court" value={[b.court?.name, durationLabel(minutes)].filter(Boolean).join(" · ")} />
        {!payKnown ? (
          <TicketRow label="Payment" value={pay.isError ? "Couldn't load" : "Checking…"} note={pay.isError ? "Pull back and open the booking again" : undefined} />
        ) : deskLike ? (
          <TicketRow label="Payment" value={`${money(price)} at the club`} note="Nothing was charged in the app" />
        ) : feeOnly ? (
          <>
            <TicketRow label="Court price" value={money(price)} note="Pay at the club" />
            <TicketRow label="CourtBook fee" value={feeLine(pay.data?.status, fee).value} note={feeLine(pay.data?.status, fee).note} />
          </>
        ) : (
          <TicketRow
            label="Paid"
            value={money(Number(pay.data?.total_usd ?? price + Number(b.fee_usd ?? 0)))}
            note={pay.data?.status === "refund_due" ? "Refund on its way" : pay.data?.status === "refunded" ? "Refunded" : `Court ${money(price)} + fee ${money(Number(b.fee_usd ?? 0))}`}
          />
        )}
        <TicketRow
          label={statusLine ? "Status" : "Cancellation"}
          value={statusLine ?? (freeCancel ? `Free until ${formatInTimeZone(cutoffAt, tz, "EEE HH:mm")}` : "Inside the cutoff")}
          note={statusLine ? undefined : freeCancel ? `${b.club.cancel_cutoff_hours} hours before you play` : `Less than ${b.club.cancel_cutoff_hours} h before start — please tell the club`}
          last
        />
      </Ticket>

      {cancel.problem && (
        <Text style={cancel.phase === "idle" ? styles.problem : styles.pending} accessibilityRole="alert" accessibilityLiveRegion="polite">{cancel.problem}</Text>
      )}

      <View style={styles.actions}>
        {feeOnly && b.status === "pending" && (
          <Button label="Pay booking fee" testID="booking-pay" onPress={() => router.push({ pathname: "/pay/[id]", params: { id: b.id } })} />
        )}
        {isNew && <Button label="See it in Bookings" onPress={() => router.dismissTo("/bookings")} />}
        {upcoming && directions && (
          <Button label="Directions" variant="secondary" onPress={() => void Linking.openURL(directions)} />
        )}
        {GAME_WRITES_AVAILABLE && b.status === "confirmed" && Date.parse(b.start_at) > Date.now() && (
          // J6 path A: open this booking to other players (the game screen handles an already-posted booking)
          <Button label="Find players" variant="secondary" onPress={() => router.push({ pathname: "/games/post", params: { booking: b.id } })} testID="find-players" />
        )}
        {isNew && <Button label="Done" variant="quiet" onPress={() => router.dismissTo("/courts")} />}
      </View>

      {upcoming && cancel.phase === "uncertain" && (
        <Button label="Check now" variant="secondary" onPress={() => void cancel.check()} />
      )}
      {upcoming && cancel.phase !== "uncertain" && (
        <View style={styles.cancelBox}>
          <Text variant="caption" style={{ textAlign: "center" }}>
            {deskLike
              ? freeCancel ? `Free to cancel before ${cutoffLabel}. Nothing was paid through CourtBook.` : `Less than ${b.club.cancel_cutoff_hours} h before start — please tell the club.`
              : feeOnly
                ? `${freeCancel ? `Free to cancel the court before ${cutoffLabel}.` : `Less than ${b.club.cancel_cutoff_hours} h before start — please tell the club.`} ${feeCancelNote(pay.data?.status, fee)}`
              : freeCancel ? `Full refund if you cancel before ${cutoffLabel}.` : `Less than ${b.club.cancel_cutoff_hours} h before start: no refund.`}
          </Text>
          <Button
            label={cancel.phase === "sending" ? "Cancelling…" : "Cancel booking"}
            variant="quiet"
            busy={cancel.phase === "sending" || cancel.phase === "checking"}
            onPress={confirmCancel}
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.lg, paddingBottom: 48 },
  hero: { alignItems: "flex-start", gap: 6, marginBottom: 4 },
  tick: { width: 52, height: 52, borderRadius: 26, backgroundColor: color.cedar, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  problem: { fontFamily: font.semibold, fontSize: 15, color: color.danger },
  pending: { fontFamily: font.semibold, fontSize: 15, color: color.warnInk },
  actions: { gap: 10 },
  cancelBox: { gap: 6, marginTop: space.md, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.line, borderRadius: radius.md },
});
