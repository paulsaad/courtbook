import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatInTimeZone } from "date-fns-tz";
import { hhmm, todayIn } from "@shared/time";
import { Text } from "../../components/Text";
import { Brand } from "../../components/Brand";
import { Chip } from "../../components/Chip";
import { Icon } from "../../components/Icon";
import { SportMark } from "../../components/SportMark";
import { Ticket, TicketRow } from "../../components/Ticket";
import { Button } from "../../components/Button";
import { PendingReservationBanner } from "../../components/PendingReservation";
import { useSession } from "../../lib/session";
import { firstName, useProfileName } from "../../lib/profile";
import { splitAgenda, useAgenda } from "../../lib/bookings";
import { BEIRUT, useDaySlots } from "../../lib/queries";
import { sportName } from "../../lib/days";
import { color, font, radius, space } from "../../lib/theme";

/**
 * Home (approved design 1R): book a court first, then the player's next booking. Everything shown is
 * read from the database — the sports offered are the ones with free courts today, the next booking
 * comes from my_agenda. Find a game and coaches join Home when those screens exist in the app (M3/M4);
 * until then nothing here points at a screen that is not built.
 */
export default function Home() {
  const session = useSession();
  const insets = useSafeAreaInsets(); // no header on Home: the brand row is the top of the screen
  const userId = session.status === "signed-in" ? session.session.user.id : null;
  const name = useProfileName(userId);
  const today = todayIn(BEIRUT);
  const slots = useDaySlots(today, null);
  const agenda = useAgenda(!!userId);

  const sports = [...new Set((slots.data ?? []).map((r) => r.court_sport))];
  const clubsToday = new Set((slots.data ?? []).map((r) => r.club_id)).size;
  const next = agenda.data ? splitAgenda(agenda.data.filter((r) => r.kind === "booking" && r.status === "confirmed")).upcoming[0] : undefined;
  const hello = firstName(name.data);

  const refreshing = slots.isRefetching || agenda.isRefetching;
  const refresh = () => { void slots.refetch(); if (userId) void agenda.refetch(); };

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + space.md }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={color.cedar} />}
    >
      <Brand />
      <Text variant="title" accessibilityRole="header">
        {userId ? (hello ? `Ready to play, ${hello}?` : "Ready to play?") : "Book a court in Lebanon"}
      </Text>
      <PendingReservationBanner />

      <View style={styles.bookCard}>
        <Pressable accessibilityRole="button" accessibilityLabel="Book a court" onPress={() => router.navigate("/courts")} style={styles.bookHead}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.bookTitle}>Book a court</Text>
            <Text style={styles.bookSub}>
              {slots.isSuccess
                ? clubsToday > 0 ? `Free times today at ${clubsToday} ${clubsToday === 1 ? "club" : "clubs"}` : "Nothing free today — see the coming days"
                : "Free times, today and this week"}
            </Text>
          </View>
          <Icon name="chevronRight" size={22} color={color.onDark} />
        </Pressable>
        {sports.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sportRow}>
            {sports.map((s) => (
              <Chip key={s} label={sportName(s)} tone="sport"
                    icon={<SportMark sport={s} size={16} />}
                    onPress={() => router.navigate({ pathname: "/courts", params: { sport: s } })} />
            ))}
          </ScrollView>
        )}
      </View>

      {userId ? (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text variant="heading">Your next booking</Text>
            <Pressable accessibilityRole="link" onPress={() => router.navigate("/bookings")} hitSlop={12}>
              <Text style={styles.link}>All bookings</Text>
            </Pressable>
          </View>
          {next ? (
            <Pressable accessibilityRole="button" accessibilityHint="Opens the booking"
                       onPress={() => router.push({ pathname: "/booking/[id]", params: { id: next.id } })}>
              <Ticket date={formatInTimeZone(new Date(next.start_at), next.timezone, "EEE d MMM")} start={hhmm(next.start_at, next.timezone)}
                      end={next.end_at ? hhmm(next.end_at, next.timezone) : undefined}>
                <TicketRow label="Club" value={next.club_name} />
                <TicketRow label="Court" value={next.title ?? "Court"} last />
              </Ticket>
            </Pressable>
          ) : agenda.isPending ? (
            <Text variant="secondary">Loading…</Text>
          ) : (
            <View style={styles.empty}>
              <Text variant="secondary">No upcoming bookings.</Text>
              <Button label="Find a court" variant="secondary" onPress={() => router.navigate("/courts")} />
            </View>
          )}
        </View>
      ) : session.status === "signed-out" ? (
        <View style={styles.empty}>
          <Text variant="secondary">Browse clubs and free times without an account. Sign in when you reserve.</Text>
          <Button label="Sign in" variant="secondary" onPress={() => router.push("/sign-in")} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.lg, paddingBottom: 40 },
  bookCard: { backgroundColor: color.night, borderRadius: radius.lg, overflow: "hidden", borderTopWidth: 4, borderTopColor: color.red },
  bookHead: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, minHeight: 72 },
  bookTitle: { fontFamily: font.score, fontSize: 26, lineHeight: 30, color: color.onDark },
  bookSub: { fontFamily: font.regular, fontSize: 15, color: color.onDarkMuted },
  sportRow: { gap: 8, paddingHorizontal: space.lg, paddingBottom: space.lg },
  section: { gap: space.md },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  link: { fontFamily: font.semibold, fontSize: 15, color: color.cedar },
  empty: { gap: space.md },
});
