import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { useQueryClient } from "@tanstack/react-query";
import { formatInTimeZone } from "date-fns-tz";
import { hhmm } from "@shared/time";
import { Text } from "../../components/Text";
import { Button } from "../../components/Button";
import { Ticket, TicketRow } from "../../components/Ticket";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { useSession } from "../../lib/session";
import { useOnline } from "../../lib/online";
import { useBooking, usePayment } from "../../lib/bookings";
import { money } from "../../lib/queries";
import { durationLabel } from "../../lib/courts";
import { supabase } from "../../lib/supabase";
import { recoverFromAuthFailure } from "../../lib/authRecovery";
import { FEE_PAYMENTS_ON, payController } from "../../lib/payments";
import { FEE_TERMS, TEST_MODE_NOTE, payView, startProblem, type PaymentStatus } from "../../lib/feePayment";
import { color, font, radius, space } from "../../lib/theme";

/**
 * Paying the CourtBook booking fee for a held court (M12.4, fee_online clubs). The court price is paid at the club;
 * only the fee is paid here, on the provider's page that the CourtBook server approved. Nothing on this screen
 * decides whether the booking is confirmed: after the page closes, on return to the app, on reopening and on
 * "Check payment" the server is asked, and its answer is what is shown. A payment whose outcome is unknown is never
 * started again on its own.
 */
export default function Pay() {
  const p = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const insets = useSafeAreaInsets();
  const online = useOnline();
  const queryClient = useQueryClient();
  const signedIn = session.status === "signed-in";
  const userId = signedIn ? session.session.user.id : null;
  const q = useBooking(signedIn ? p.id : undefined);
  const b = q.data;
  const pay = usePayment(signedIn && b ? b.id : undefined);
  const ctl = payController();

  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<"pay" | "check" | "abandon" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const feeOnly = pay.data?.kind === "fee_only";
  const paymentId = feeOnly ? pay.data!.id : null;

  const check = useCallback(async (quiet = false) => {
    if (!userId || !paymentId) return;
    setBusy((x) => x ?? "check");
    const r = await ctl.check(userId, paymentId);
    setBusy((x) => (x === "check" ? null : x));
    if (r.kind === "status") {
      setStatus(r.status);
      if (!quiet) setProblem(null);   // a quiet look (after a start, on resume) keeps what the player was just told
      if (r.status.state !== "payment_open" && r.status.state !== "awaiting_payment") {
        void queryClient.invalidateQueries({ queryKey: ["booking", p.id] });
        void queryClient.invalidateQueries({ queryKey: ["payment", p.id] });
        void queryClient.invalidateQueries({ queryKey: ["my-agenda"] });
      }
    } else if (r.kind === "auth") {
      setProblem("Your sign-in expired. Sign in again; your hold and any payment are kept.");
      void recoverFromAuthFailure();
    } else if (r.kind === "refused") {
      setProblem(r.error === "payments_not_configured" ? "Payments are not available in the app right now. Nothing was charged." : "This payment couldn't be checked.");
    } else if (r.kind === "offline") {
      if (!quiet) setProblem("You're offline. Reconnect, then tap Check payment.");
    } else if (r.kind === "unknown") {
      if (!quiet) setProblem("We couldn't reach CourtBook. Your payment is safe — check again in a moment.");
    }
  }, [ctl, userId, paymentId, queryClient, p.id]);

  // the first look, and recovery: this account remembers which payment it is in the middle of
  useEffect(() => {
    if (!userId || !b || !paymentId) return;
    // remember this payment WITHOUT replacing any other one this account has open; then look, and read where the
    // others stand (the ones that ended are tidied away, the rest stay remembered)
    void ctl.remember(userId, b.id, paymentId).then(() => check(true)).then(() => ctl.settleOthers(userId, paymentId));
  }, [userId, b?.id, paymentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // coming back to the app (from the payment page, from another app, after a long time away) → ask again
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void check(true); });
    return () => sub.remove();
  }, [check]);
  useEffect(() => { if (online && status && (status.state === "checking" || status.state === "payment_open")) void check(true); }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  // the countdown (display only: the server decides whether the hold is still live)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // confirmed: the booking's own confirmation screen (never "Court booked" before this)
  const shownConfirmed = useRef(false);
  useEffect(() => {
    if (status?.state === "confirmed" && b && !shownConfirmed.current) {
      shownConfirmed.current = true;
      router.replace({ pathname: "/booking/[id]", params: { id: b.id, new: "1" } });
    }
  }, [status?.state, b]);

  if (session.status === "loading") return <Loading label="Checking sign-in" />;
  if (!signedIn) return <SignInPrompt title="Sign in to pay for this booking" body="Your bookings are only shown to you." />;
  if (q.isPending || (b && pay.isPending)) return <Loading label="Loading your booking" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (pay.isError) return <ErrorState error={pay.error} onRetry={() => void pay.refetch()} />;
  if (!b) return <Empty title="Booking not found" body="It isn't one of your bookings." action="Go to Bookings" onAction={() => router.dismissTo("/bookings")} />;
  if (!FEE_PAYMENTS_ON || !pay.data || !feeOnly) {
    // Model 1 (court and fee online) and any payment this version does not handle: the website, as before
    return (
      <Empty
        title={b.status === "confirmed" ? "Court booked" : "Finish this booking on the website"}
        body={b.status === "confirmed" ? "This booking is confirmed." : "This booking's payment isn't handled in the app yet. Open CourtBook on the website to finish it."}
        action="See booking"
        onAction={() => router.replace({ pathname: "/booking/[id]", params: { id: b.id } })}
      />
    );
  }

  const tz = b.club.timezone;
  const minutes = Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60_000);
  const price = Number(b.price_usd ?? 0);
  const fee = Number(b.fee_usd ?? 0);
  const holdAt = status?.holdExpiresAt ?? b.hold_expires_at ?? null;
  const holdLeftMs = holdAt ? Date.parse(holdAt) - now : null;
  const view = payView(status, { holdLeftMs, online, busy: busy !== null });
  const simulated = pay.data.provider === "simulated";

  async function onPrimary() {
    if (!userId || !paymentId || busy) return;
    if (view.primary === "check") return void check();
    if (view.primary === "view-booking") return router.replace({ pathname: "/booking/[id]", params: { id: b!.id } });
    if (view.primary !== "pay" && view.primary !== "continue") return;
    setBusy("pay");
    setProblem(null);
    const r = await ctl.start(userId, b!.id, paymentId);
    if (r.kind === "busy") { setBusy(null); return; }
    if (r.kind === "offline") { setBusy(null); setProblem("You're offline, so nothing was sent. Reconnect and try again."); return; }
    if (r.kind === "not-saved") { setBusy(null); setProblem("Your phone couldn't save this payment safely, so nothing was sent. Try again — if it keeps happening, restart the app."); return; }
    if (r.kind === "redirect") {
      // The page is the provider's, opened in the system browser (Custom Tab). Whatever happens there — paid, closed,
      // the app killed — the answer comes from the server afterwards, not from how the page was left.
      try {
        await WebBrowser.openAuthSessionAsync(r.url, Linking.createURL("payment-return"));
      } catch {
        setProblem("The payment page couldn't be opened. Nothing was charged by opening it — tap Check payment.");
      }
      setBusy(null);
      return void check();
    }
    setBusy(null);
    if (r.kind === "auth") void recoverFromAuthFailure();
    setProblem(startProblem(r, online));
    void check(true);   // a read: shows where the payment stands. Nothing is started again.
  }

  function onAbandon() {
    if (!view.canAbandon || busy) return;
    Alert.alert("Release this court?", "Your hold ends now and the court is free for others. Nothing has been charged.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Release", style: "destructive", onPress: async () => {
          setBusy("abandon");
          const { error } = await supabase.rpc("release_hold", { p_booking: b!.id });
          setBusy(null);
          if (error) { setProblem("The hold couldn't be released. Check your connection and try again."); return; }
          if (userId) await ctl.forget(userId, paymentId!);
          void queryClient.invalidateQueries({ queryKey: ["my-agenda"] });
          void queryClient.invalidateQueries({ queryKey: ["day-slots"] });
          void queryClient.invalidateQueries({ queryKey: ["active-hold"] });
          router.dismissTo("/courts");
        },
      },
    ]);
  }

  const mm = holdLeftMs !== null ? Math.max(0, Math.floor(holdLeftMs / 60_000)) : null;
  const ss = holdLeftMs !== null ? Math.max(0, Math.floor((holdLeftMs % 60_000) / 1000)) : null;
  const countdown = view.countdown && holdLeftMs !== null
    ? holdLeftMs > 0 ? `Held for you for ${mm}:${String(ss).padStart(2, "0")}` : "Your hold time is up"
    : null;

  return (
    <ScrollView style={styles.page} contentContainerStyle={[styles.content, { paddingBottom: 48 + insets.bottom }]}>
      <Stack.Screen options={{ title: "Booking fee" }} />
      <View accessibilityRole="header">
        <Text variant="title" style={{ fontSize: 26, lineHeight: 30 }}>{view.title}</Text>
      </View>
      {countdown && (
        <Text style={[styles.countdown, holdLeftMs !== null && holdLeftMs <= 60_000 && { color: color.danger }]} accessibilityLiveRegion="polite"
          accessibilityLabel={holdLeftMs !== null && holdLeftMs > 0 ? `Held for you for ${mm} minutes ${ss} seconds` : countdown}>
          {countdown}
        </Text>
      )}

      <Ticket
        date={formatInTimeZone(new Date(b.start_at), tz, "EEEE d MMMM")}
        start={hhmm(b.start_at, tz)}
        end={hhmm(b.end_at, tz)}
      >
        <TicketRow label="Club" value={b.club.name} />
        <TicketRow label="Court" value={[b.court?.name, durationLabel(minutes)].filter(Boolean).join(" · ")} />
        <TicketRow label="Court price" value={money(price)} note="Pay at the club" />
        <TicketRow label="CourtBook booking fee" value={money(fee)} note="Pay online now" last />
      </Ticket>

      {view.message && <Text style={view.tone === "bad" ? styles.problem : view.tone === "warn" ? styles.pending : undefined} variant="body">{view.message}</Text>}
      {problem && <Text style={styles.problem} accessibilityRole="alert" accessibilityLiveRegion="polite">{problem}</Text>}

      <View style={styles.actions}>
        {view.primary !== "none" && (
          <Button
            testID="pay-primary"
            label={busy === "pay" ? "Opening payment…" : busy === "check" && view.primary === "check" ? "Checking…" : view.primaryLabel}
            busy={busy === "pay" || (busy === "check" && view.primary === "check")}
            disabled={(!online && view.primary !== "view-booking") || (busy !== null && busy !== "check")}
            onPress={() => void onPrimary()}
          />
        )}
        {view.canCheck && view.primary !== "check" && (
          <Button testID="pay-check" label={busy === "check" ? "Checking…" : "Check payment"} variant="secondary" busy={busy === "check"} disabled={!online || busy === "pay"} onPress={() => void check()} />
        )}
        {view.canAbandon && (
          <Button testID="pay-abandon" label="Release this court" variant="quiet" disabled={busy !== null} onPress={onAbandon} />
        )}
        {view.primary === "none" && (
          <Button label="See booking" variant="secondary" onPress={() => router.replace({ pathname: "/booking/[id]", params: { id: b.id } })} />
        )}
      </View>

      <View style={styles.terms}>
        <Text variant="caption">{FEE_TERMS}</Text>
        {simulated && <Text variant="caption" style={{ color: color.warnInk }}>{TEST_MODE_NOTE}</Text>}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.lg },
  countdown: { fontFamily: font.semibold, fontSize: 16, color: color.warnInk },
  problem: { fontFamily: font.semibold, fontSize: 15, color: color.danger },
  pending: { fontFamily: font.semibold, fontSize: 15, color: color.warnInk },
  actions: { gap: 10 },
  terms: { gap: 6, paddingTop: space.md, borderTopWidth: 1, borderTopColor: color.line, borderRadius: radius.md },
});
