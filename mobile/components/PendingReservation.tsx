import { useEffect, useRef, useSyncExternalStore } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { hhmm } from "@shared/time";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { useSession } from "../lib/session";
import { reservations, type Selection } from "../lib/pendingReservation";
import { shortDate } from "../lib/days";
import { color, font, radius, space } from "../lib/theme";

/**
 * Mounted once at the root. Tells the store who is signed in, and asks it to look again when the
 * connection returns or the app comes back to the front. Refreshes bookings and times when an
 * attempt resolves as booked.
 */
export function PendingReservationWatcher() {
  const session = useSession();
  const queryClient = useQueryClient();
  const store = reservations();
  const userId = session.status === "signed-in" ? session.session.user.id : null;

  useEffect(() => {
    if (session.status !== "loading") void store.setUser(userId);
  }, [session.status, userId, store]);
  useEffect(() => onlineManager.subscribe((online) => { if (online) store.recheckIfWaiting(); }), [store]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") store.recheckIfWaiting(); });
    return () => sub.remove();
  }, [store]);

  const seen = useRef<string | null>(null);
  useEffect(() => store.subscribe(() => {
    const o = store.getState().outcome;
    if (o?.kind === "booked" && seen.current !== o.bookingId) {
      seen.current = o.bookingId;
      void queryClient.invalidateQueries({ queryKey: ["my-agenda"] });
      void queryClient.invalidateQueries({ queryKey: ["day-slots"] });
    }
  }), [store, queryClient]);
  return null;
}

export function describe(sel: Selection): string {
  return `${sel.clubName} · ${shortDate(sel.date)}, ${hhmm(sel.start, sel.timezone)} · ${sel.courtName}`;
}

/**
 * The player's unresolved reservation, on the screens they go to next (Home, Courts, Bookings,
 * another club). Stays until the database has answered; "Check now" only reads, never re-sends.
 * After it resolves away from the club's screen, says how it ended once.
 */
export function PendingReservationBanner({ style }: { style?: object }) {
  const store = reservations();
  const s = useSyncExternalStore(store.subscribe, store.getState);
  const mine = s.pending && s.userId && s.pending.userId === s.userId ? s.pending : null;

  if (mine) {
    const busy = s.phase === "sending" || s.phase === "checking";
    return (
      <View style={[styles.card, styles.waiting, style]} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="pending-banner">
        <View style={styles.head}>
          <Icon name="clock" size={20} color={color.warnInk} />
          <Text style={[styles.title, { color: color.warnInk }]}>Booking not confirmed yet</Text>
        </View>
        <Text variant="strong">{describe(mine.sel)}</Text>
        <Text variant="secondary">{s.phase === "sending" ? "Reserving…" : s.note}</Text>
        <Text variant="caption">You can't reserve another court until we know.</Text>
        <Button label={s.phase === "checking" ? "Checking…" : s.phase === "sending" ? "Reserving…" : "Check now"} variant="secondary" busy={busy} onPress={() => void store.check()} />
      </View>
    );
  }

  const o = s.outcome && s.outcome.userId === s.userId ? s.outcome : null;
  if (!o) return null;
  if (o.kind === "booked") {
    return (
      <View style={[styles.card, styles.done, style]} accessibilityRole="alert" testID="pending-banner">
        <View style={styles.head}>
          <Icon name="check" size={20} color={color.cedarDeep} strokeWidth={2.4} />
          <Text style={[styles.title, { color: color.cedarDeep, flex: 1 }]}>Your booking went through</Text>
          <Close onPress={() => store.acknowledge()} />
        </View>
        <Text variant="strong">{describe(o.sel)}</Text>
        <Button label="View booking" onPress={() => { store.acknowledge(); router.push({ pathname: "/booking/[id]", params: { id: o.bookingId } }); }} />
      </View>
    );
  }
  return (
    <View style={[styles.card, styles.ended, style]} accessibilityRole="alert" testID="pending-banner">
      <View style={styles.head}>
        <Text style={[styles.title, { flex: 1 }]}>Booking not made</Text>
        <Close onPress={() => store.acknowledge()} />
      </View>
      <Text variant="strong">{describe(o.sel)}</Text>
      <Text variant="secondary">{o.message}</Text>
    </View>
  );
}

function Close({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={12} onPress={onPress} style={styles.close}>
      <Icon name="close" size={18} color={color.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg, gap: 6 },
  waiting: { backgroundColor: color.warnSoft, borderColor: "#EBCF8F" },
  done: { backgroundColor: color.cedarSoft, borderColor: "#B9DCC6" },
  ended: { backgroundColor: color.card, borderColor: color.line },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontFamily: font.bold, fontSize: 16, lineHeight: 21, color: color.ink },
  close: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
});
