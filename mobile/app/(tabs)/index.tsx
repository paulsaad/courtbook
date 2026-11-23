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
import { AreasQuestionCard, YourClubsRow } from "../../components/HomeExtras";
import { useSession } from "../../lib/session";
import { firstName, useProfileName } from "../../lib/profile";
import { splitAgenda, useAgenda } from "../../lib/bookings";
import { BEIRUT, useDaySlots } from "../../lib/queries";
import { sportName } from "../../lib/days";
import { badgeText, unreadCount, useActivity } from "../../lib/activity";
import { color, font, radius, space, TOUCH } from "../../lib/theme";

/**
 * Home (approved design 1R): book a court first, then the player's next booking. Everything shown is
 * read from the database — the sports offered are the ones with free courts today, the next booking
 * comes from my_agenda. Find a game (M3) opens the games board; coaches join Home when that screen
 * exists (M4) — nothing here points at a screen that is not built.
 */
/** Home header bell (§4.7): opens Activity; the unread count is a red badge and part of the label. */
function ActivityBell() {
  const q = useActivity({ signedIn: true });
  const n = unreadCount(q.data);
  const badge = badgeText(n);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={n ? `Activity, ${n} unread` : "Activity"} onPress={() => router.push("/activity")}
               style={styles.bell} hitSlop={4} testID="home-activity">
      <Icon name="bell" size={24} color={color.ink} />
      {badge ? <View style={styles.badge}><Text style={styles.badgeText}>{badge}</Text></View> : null}
    </Pressable>
  );
}

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
      <View style={styles.brandRow}>
        <Brand />
        {userId ? <ActivityBell /> : null}
      </View>
      <Text variant="title" accessibilityRole="header">
        {userId ? (hello ? `Ready to play, ${hello}?` : "Ready to play?") : "Book a court in Lebanon"}
      </Text>
      <PendingReservationBanner />
      {userId ? <AreasQuestionCard userId={userId} /> : null}

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

      {userId ? <YourClubsRow userId={userId} /> : null}

      <Pressable accessibilityRole="button" accessibilityLabel="Find a game" accessibilityHint="Games that need players"
                 onPress={() => router.push("/games")} style={({ pressed }) => [styles.gameCard, pressed && { opacity: 0.9 }]} testID="home-find-a-game">
        <View style={styles.gameIcon}><Icon name="players" size={24} color={color.cedar} /></View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.gameTitle}>Find a game</Text>
          <Text variant="secondary">Games that need players</Text>
        </View>
        <Icon name="chevronRight" size={22} color={color.muted} />
      </Pressable>

      {userId ? (
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text variant="heading">Your next booking</Text>
            <Pressable accessibilityRole="link" onPress={() => router.navigate("/bookings")} hitSlop={{ left: 12, right: 12 }} style={{ minHeight: 44, justifyContent: "center" }}>
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
  brandRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  bell: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", marginRight: -space.sm },
  badge: { position: "absolute", top: 4, right: 2, minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: color.red },
  badgeText: { fontFamily: font.bold, fontSize: 12, lineHeight: 15, color: color.onDark },
  gameCard: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, minHeight: 72, backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line },
  gameIcon: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: color.cedarSoft },
  gameTitle: { fontFamily: font.score, fontSize: 24, lineHeight: 28, color: color.ink },
  section: { gap: space.md },
  // Wraps at large text sizes so "All bookings" drops below the heading instead of off the screen.
  sectionHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 12 },
  link: { fontFamily: font.semibold, fontSize: 15, color: color.cedar },
  empty: { gap: space.md },
});
