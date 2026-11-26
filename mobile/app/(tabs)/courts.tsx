import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { PendingReservationBanner } from "../../components/PendingReservation";
import { router, useLocalSearchParams } from "expo-router";
import { hhmm } from "@shared/time";
import { Text } from "../../components/Text";
import { Chip } from "../../components/Chip";
import { Icon } from "../../components/Icon";
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
import { FavouriteHeart } from "../../components/FavouriteHeart";
import { useSession } from "../../lib/session";
import { rememberArea, usePlayingPrefs } from "../../lib/playing";
import { areaKey, distanceLabel, sameArea, sortByDistance, type PlayingArea } from "@shared/places";
import { locationNote } from "../../lib/nearby";
import { useNearby } from "../../lib/deviceLocation";
import { useAreaList, useClubPoints } from "../../lib/clubDirectory";
import { color, font, MAX_FONT_SCALE, radius, space, TOUCH } from "../../lib/theme";

/**
 * Courts: which clubs have free times on a day, compared without opening each one (approved
 * design 2). Reads club_day_slots, the same function as the website; visitors can browse.
 * Signed in (0088): the player's saved areas are one-tap chips, and the area they browsed last — on any device — is
 * where the tab opens. Hearts save favourite clubs (0087).
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
  const session = useSession();
  const userId = session.status === "signed-in" ? session.session.user.id : null;
  const playing = usePlayingPrefs(userId);
  const [area, setArea] = useState<PlayingArea | null>(null);
  const [restored, setRestored] = useState(false);
  // open where the player last browsed (their account's last area), once
  useEffect(() => {
    if (restored || !playing.isSuccess) return;
    setRestored(true);
    if (playing.data?.last) setArea(playing.data.last);
  }, [playing.isSuccess, playing.data, restored]);
  const near = useNearby();
  const nearOn = near.state.status === "on";
  // M14 review B: Near me shows every club in Lebanon, nearest first. The area the player was browsing (or the one
  // restored from their account, even if it arrives after Near me came on) never narrows it; it is kept, and comes
  // back when Near me is turned off. Choosing an area chip turns Near me off, including one still asking.
  const browseArea = nearOn ? null : area;
  const pickArea = (a: PlayingArea | null) => { near.turnOff(); setArea(a); if (userId && playing.data) rememberArea(a); };
  const points = useClubPoints(nearOn);
  // Visitors (no account, nothing saved): the governorates as one-tap chips, so refusing location still leaves a
  // way to narrow the list (spec addendum R2). Not remembered anywhere.
  const govs = useAreaList(!userId);
  const saved = playing.data?.areas ?? [];
  // "Club or town" (the website's Courts search): typed, then searched on the keyboard's Search key
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const q = useDaySlots(date, sport, browseArea, search);
  const clubs = useMemo(() => clubsFromSlots(q.data ?? []), [q.data]);
  const free = clubs.filter((c) => c.starts.length > 0);
  // Near me: nearest first by straight-line distance; clubs without a map point keep their order after the others
  // "Nearest first" is only said when the list really is sorted: the club points may still be loading or have failed
  const sorted = nearOn && near.state.status === "on" && !!points.data;
  const open = sorted && near.state.status === "on" && points.data
    ? sortByDistance(free, points.data, near.state.point).map(({ item, km }) => ({ ...item, km }))
    : free.map((c) => ({ ...c, km: null as number | null }));
  const note = locationNote(near.state);
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
        {userId && playing.data && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} testID="area-chips">
            <Chip label="All Lebanon" selected={!nearOn && area === null} onPress={() => pickArea(null)} />
            {saved.map((a) => <Chip key={areaKey(a)} label={a.label ?? a.governorate} selected={!nearOn && sameArea(a, area)} onPress={() => pickArea(a)} />)}
            {area && !saved.some((a) => sameArea(a, area)) && <Chip label={area.label ?? "Last area"} selected={!nearOn} onPress={() => pickArea(area)} />}
            <Chip label={saved.length ? "Edit areas" : "Add your areas"} onPress={() => router.push("/areas")} icon={<Icon name="pin" size={16} color={color.cedar} />} />
          </ScrollView>
        )}
        {!userId && govs.data && govs.data.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} testID="visitor-area-chips">
            <Chip label="All Lebanon" selected={!nearOn && area === null} onPress={() => pickArea(null)} />
            {govs.data.map((g) => {
              const a: PlayingArea = { governorate: g.code, district: null, town: null, label: g.name_en };
              return <Chip key={g.code} label={g.name_en} selected={!nearOn && sameArea(a, area)} onPress={() => pickArea(a)} />;
            })}
          </ScrollView>
        )}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip label={near.busy ? "Finding you…" : "Near me"} selected={nearOn} disabled={near.busy} testID="near-me"
                onPress={() => void near.toggle()} icon={<Icon name="compass" size={16} color={nearOn ? color.onDark : color.cedar} />} />
        </ScrollView>
        {note ? <Text variant="secondary" style={{ paddingHorizontal: space.lg }} testID="near-note">{note}</Text> : null}
        <View style={styles.search} testID="courts-search">
          <Icon name="search" size={18} color={color.muted} />
          <TextInput
            value={typed} onChangeText={setTyped} onSubmitEditing={() => setSearch(typed.trim())} returnKeyType="search" enterKeyHint="search"
            placeholder="Club or town" placeholderTextColor={color.booked} accessibilityLabel="Search clubs or towns" autoCorrect={false}
            maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.searchInput} testID="courts-search-input"
          />
          {typed ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => { setTyped(""); setSearch(""); }} style={styles.clear} testID="courts-search-clear">
              <Icon name="close" size={18} color={color.muted} />
            </Pressable>
          ) : null}
        </View>
        {search ? <Text variant="secondary" style={{ paddingHorizontal: 20 }} testID="courts-search-note">Showing clubs matching “{search}”</Text> : null}
        <DateStrip days={days} selected={date} onSelect={setDate} />
      </View>

      <View style={styles.summary}>
        {q.isSuccess && sorted && <Text variant="secondary">Nearest first · straight-line distances</Text>}
        {nearOn && points.isError && !points.data && (
          <View style={styles.pointsError} testID="points-error">
            <Text variant="secondary" style={{ flexShrink: 1 }}>Couldn't load club locations, so the list isn't sorted by distance.</Text>
            <Pressable accessibilityRole="button" onPress={() => void points.refetch()} style={styles.more}><Text style={styles.moreText}>Try again</Text></Pressable>
          </View>
        )}
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
        search ? (
          <Empty title={`No free courts matching “${search}”`} body="Check the spelling, try another day, or clear the search." action="Clear search" onAction={() => { setTyped(""); setSearch(""); }} />
        ) : (
          <Empty title="Nothing free that day" body="Try another day or another sport." />
        )
      ) : (
        <View style={styles.list}>
          {open.map((c) => <ClubCard key={c.id} club={c} date={date} sport={sport} cover={covers.data?.get(c.id) ?? null} userId={userId} km={c.km} />)}
        </View>
      )}
    </ScrollView>
  );
}

/**
 * Above this text scale the price moves under the club name instead of beside it: on a 360 dp phone
 * the column beside the price is too narrow and words break mid-word ("Batr/oun", F1, 18 Nov).
 */
export const PRICE_BESIDE_NAME_MAX_SCALE = 1.3;

export function ClubCard({ club, date, sport, cover, userId = null, km = null }: { club: ClubDay; date: string; sport: string | null; cover: string | null; userId?: string | null; km?: number | null }) {
  const dist = km != null ? distanceLabel(km) : null;
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > PRICE_BESIDE_NAME_MAX_SCALE;
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
      {/* the heart sits beside the card's button, not inside it: VoiceOver reads a button as one element */}
      <View style={styles.cardTopRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={[club.name, dist?.a11y, club.town, courts, from !== null ? `from ${from} dollars an hour` : null].filter(Boolean).join(", ")} onPress={() => go()} style={[styles.cardTop, { flex: 1 }]}>
        <View style={styles.thumb}>
          {cover ? (
            <Image source={{ uri: cover }} style={styles.thumbImg} contentFit="cover" transition={fade(150)} accessible={false} />
          ) : (
            <CourtLines opacity={0.3} width={64} height={64} right={0} top={0} />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View testID="club-name-row" style={stacked ? styles.nameStacked : styles.nameRow}>
            {/* No line limit: at the largest text sizes the full name wraps rather than being cut (F1). */}
            <Text style={styles.name}>{club.name}</Text>
            {from !== null && (
              <Text style={styles.from}>from <Text style={styles.price}>${from}</Text>/h</Text>
            )}
          </View>
          <Text variant="secondary">
            {[dist?.text, club.town, courts].filter(Boolean).join(" · ")}
          </Text>
          {club.isDemo && <Text style={styles.demo}>Demo club — not a real venue</Text>}
        </View>
      </Pressable>
      {userId ? <FavouriteHeart clubId={club.id} clubName={club.name} userId={userId} /> : null}
      </View>
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
  cardTopRow: { flexDirection: "row", alignItems: "flex-start" },
  filters: { backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.line, paddingTop: space.md, paddingBottom: space.md, gap: space.md },
  chips: { gap: 8, paddingHorizontal: 20 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 20, paddingLeft: 14, borderWidth: 1, borderColor: color.line, borderRadius: radius.pill, backgroundColor: color.card, minHeight: TOUCH },
  searchInput: { flex: 1, minWidth: 0, fontFamily: font.regular, fontSize: 16, color: color.ink, paddingVertical: 8 },
  clear: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" },
  summary: { paddingHorizontal: 20, paddingTop: space.lg, gap: 4 },
  list: { padding: 20, paddingTop: space.md, gap: 10 },
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, padding: 14 },
  cardTop: { flexDirection: "row", gap: 12 },
  thumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: color.cedarDeep, overflow: "hidden" },
  thumbImg: { width: 64, height: 64 },
  nameRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  nameStacked: { gap: 2 },
  name: { fontFamily: font.bold, fontSize: 17, lineHeight: 22, color: color.ink, flexShrink: 1 },
  from: { fontFamily: font.regular, fontSize: 13, color: color.muted },
  price: { fontFamily: font.score, fontSize: 20, color: color.ink },
  demo: { fontFamily: font.semibold, fontSize: 13, color: color.warnInk, marginTop: 2 },
  times: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12, alignItems: "center" },
  time: { minHeight: 44, minWidth: 64, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1.5, borderColor: color.cedar, alignItems: "center", justifyContent: "center" },
  timeText: { fontFamily: font.score, fontSize: 18, color: color.cedarDeep },
  pointsError: { flexDirection: "row", alignItems: "center", gap: 8 },
  more: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  moreText: { fontFamily: font.semibold, fontSize: 15, color: color.cedarDeep },
});
