import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { PendingReservationBanner } from "../../components/PendingReservation";
import { router, useLocalSearchParams } from "expo-router";
import { hhmm } from "@shared/time";
import { Text } from "../../components/Text";
import { Chip } from "../../components/Chip";
import { DateStrip } from "../../components/DateStrip";
import { SportMark, SPORTS } from "../../components/SportMark";
import { CourtLines } from "../../components/CourtLines";
import { Image } from "expo-image";
import { useClubCovers } from "../../lib/clubInfo";
import { fade } from "../../lib/motion";
import { Freshness } from "../../components/Freshness";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { clubsFromSlots, type ClubDay } from "../../lib/courts";
import { BEIRUT, useDaySlots } from "../../lib/queries";
import { bookingDays, sportName } from "../../lib/days";
import { color, font, radius, space } from "../../lib/theme";

/**
 * Courts: which clubs have free times on a day, compared without opening each one (approved
 * design 2). Reads club_day_slots, the same function as the website; visitors can browse.
 */
export default function Courts() {
  const days = useMemo(() => bookingDays(BEIRUT), []);
  const [date, setDate] = useState(days[0].key);
  const [sport, setSport] = useState<string | null>(null);
  // Home's sport chips open this tab with ?sport=…; a later chip tap on Home changes it again
  const p = useLocalSearchParams<{ sport?: string }>();
  useEffect(() => {
    if (p.sport && (SPORTS as readonly string[]).includes(p.sport)) setSport(p.sport);
  }, [p.sport]);
  const q = useDaySlots(date, sport);
  const clubs = useMemo(() => clubsFromSlots(q.data ?? []), [q.data]);
  const open = clubs.filter((c) => c.starts.length > 0);
  const covers = useClubCovers(open.map((c) => c.id));

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{ paddingBottom: 32 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={color.cedar} />}
    >
      <PendingReservationBanner style={{ marginHorizontal: 16, marginTop: 12 }} />
      <View style={styles.filters}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip tone="sport" label="All sports" selected={sport === null} onPress={() => setSport(null)} />
          {SPORTS.filter((s) => s !== "other").map((s) => (
            <Chip key={s} tone="sport" label={sportName(s)} selected={sport === s} onPress={() => setSport(s)} icon={<SportMark sport={s} size={20} />} />
          ))}
        </ScrollView>
        <DateStrip days={days} selected={date} onSelect={setDate} />
      </View>

      <View style={styles.summary}>
        {q.isSuccess && (
          <Text variant="label">
            {open.length === 0 ? "No free courts" : `${open.length} ${open.length === 1 ? "club" : "clubs"} with free times`}
          </Text>
        )}
        <Freshness lastSuccessAt={q.dataUpdatedAt} fetching={q.isFetching} failedSinceSuccess={q.isError && q.dataUpdatedAt > 0} />
      </View>

      {q.isPending ? (
        <Loading label="Loading courts" />
      ) : q.isError && !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : open.length === 0 ? (
        <Empty title="Nothing free that day" body="Try another day or another sport." />
      ) : (
        <View style={styles.list}>
          {open.map((c) => <ClubCard key={c.id} club={c} date={date} sport={sport} cover={covers.data?.get(c.id) ?? null} />)}
        </View>
      )}
    </ScrollView>
  );
}

function ClubCard({ club, date, sport, cover }: { club: ClubDay; date: string; sport: string | null; cover: string | null }) {
  const go = (at?: string) =>
    router.push({ pathname: "/club/[id]", params: { id: club.id, name: club.name, date, ...(sport ? { sport } : {}), ...(at ? { at } : {}) } });
  const shown = club.starts.slice(0, 3);
  // club_day_slots' price_from is the cheapest rule across the whole club, every sport. It is only
  // honest as "from" when no sport is chosen; with a sport, the exact prices are on the club screen.
  const from = sport ? null : club.priceFrom;
  // Only courts with at least one free start that day come back, so this counts free courts.
  const courts = `${club.courtCount} ${sport ? `${sportName(sport).toLowerCase()} ` : ""}${club.courtCount === 1 ? "court" : "courts"} free`;
  const more = club.starts.length - shown.length;
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityLabel={[club.name, club.town, courts, from !== null ? `from ${from} dollars an hour` : null].filter(Boolean).join(", ")} onPress={() => go()} style={styles.cardTop}>
        <View style={styles.thumb}>
          {cover ? (
            <Image source={{ uri: cover }} style={styles.thumbImg} contentFit="cover" transition={fade(150)} accessible={false} />
          ) : (
            <CourtLines opacity={0.3} width={64} height={64} right={0} top={0} />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={2}>{club.name}</Text>
            {from !== null && (
              <Text style={styles.from}>from <Text style={styles.price}>${from}</Text>/h</Text>
            )}
          </View>
          <Text variant="secondary">
            {[club.town, courts].filter(Boolean).join(" · ")}
          </Text>
          {club.isDemo && <Text style={styles.demo}>Demo club — not a real venue</Text>}
        </View>
      </Pressable>
      <View style={styles.times}>
        {shown.map((s) => (
          <Pressable key={s} accessibilityRole="button" accessibilityLabel={`${hhmm(s, club.timezone)} at ${club.name}`} onPress={() => go(s)} style={styles.time}>
            <Text style={styles.timeText}>{hhmm(s, club.timezone)}</Text>
          </Pressable>
        ))}
        {more > 0 && (
          <Pressable accessibilityRole="button" onPress={() => go()} style={styles.more}>
            <Text style={styles.moreText}>+{more} more</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  filters: { backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.line, paddingTop: space.md, paddingBottom: space.md, gap: space.md },
  chips: { gap: 8, paddingHorizontal: 20 },
  summary: { paddingHorizontal: 20, paddingTop: space.lg, gap: 4 },
  list: { padding: 20, paddingTop: space.md, gap: 10 },
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: 14 },
  cardTop: { flexDirection: "row", gap: 12 },
  thumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: color.cedarDeep, overflow: "hidden" },
  thumbImg: { width: 64, height: 64 },
  nameRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  name: { fontFamily: font.bold, fontSize: 17, lineHeight: 22, color: color.ink, flexShrink: 1 },
  from: { fontFamily: font.regular, fontSize: 13, color: color.muted },
  price: { fontFamily: font.score, fontSize: 20, color: color.ink },
  demo: { fontFamily: font.semibold, fontSize: 13, color: color.warnInk, marginTop: 2 },
  times: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12, alignItems: "center" },
  time: { minHeight: 44, minWidth: 64, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1.5, borderColor: color.cedar, alignItems: "center", justifyContent: "center" },
  timeText: { fontFamily: font.score, fontSize: 18, color: color.cedarDeep },
  more: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  moreText: { fontFamily: font.semibold, fontSize: 15, color: color.cedarDeep },
});
