import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { router, Stack } from "expo-router";
import { Text } from "../../components/Text";
import { Chip } from "../../components/Chip";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { SportMark, SPORTS } from "../../components/SportMark";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { GameCard } from "../../components/game/GameCard";
import { AreaSheet, areaLabel } from "../../components/game/AreaSheet";
import { useSession } from "../../lib/session";
import { useAreas, useMyLevels } from "../../lib/games";
import { useFindGames } from "../../lib/gameScreens";
import { activeFilterCount, capNote, DEFAULT_FILTERS, myLevelNote, type GameFilters, type When } from "../../lib/gameFilters";
import { sportName } from "../../lib/days";
import { useOnline } from "../../lib/online";
import { GAME_WRITES_AVAILABLE } from "../../lib/gameActions";
import { GameBanner } from "../../components/game/GameBanner";
import { SUSPENDED_TEXT, SUSPENDED_TITLE, useSafety } from "../../lib/safety";
import { color, font, space, TOUCH } from "../../lib/theme";

const WHEN: { key: When; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "any", label: "Any time" },
];
const BOARD_SPORTS = SPORTS.filter((s) => s !== "other");

/** "18:42" in the phone's clock, for "Updated 18:42". */
function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Find a game (approved Stitch export 14; docs/m3/04-ux-spec.md §4.3, journey J1). Every game shown
 * is a row from open_matches() under the player's own session: the filters only choose which games
 * to ask the database for. Posting a game is not offered until game writes are switched on.
 */
export default function FindAGame() {
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const online = useOnline();
  const [filters, setFilters] = useState<GameFilters>(DEFAULT_FILTERS);
  const [areaOpen, setAreaOpen] = useState(false);
  const board = useFindGames(filters, { signedIn });
  const levels = useMyLevels({ signedIn });
  const areas = useAreas({ signedIn });
  const suspended = useSafety(signedIn).suspended;
  const set = (patch: Partial<GameFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const active = activeFilterCount(filters);
  const myLevel = filters.sport && levels.data?.[filters.sport] != null ? levels.data[filters.sport] : null;
  const levelNote = myLevelNote(filters, levels.data ?? {});
  const cap = capNote(board.rows.length);

  const header = useMemo(() => (
    <View style={styles.header}>
      <Text variant="title" accessibilityRole="header" style={styles.title}>Find a game</Text>
      {suspended ? <View style={styles.pad}><GameBanner tone="warn" title={SUSPENDED_TITLE} text={SUSPENDED_TEXT} testID="account-suspended" /></View> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sports} accessibilityLabel="Sport">
        <Chip label="All sports" tone="sport" selected={!filters.sport} onPress={() => set({ sport: null })} />
        {BOARD_SPORTS.map((s) => (
          <Chip key={s} label={sportName(s)} tone="sport" selected={filters.sport === s} icon={<SportMark sport={s} size={16} />}
                onPress={() => set({ sport: filters.sport === s ? null : s })} />
        ))}
      </ScrollView>
      <View style={styles.pad}>
        <Segmented options={WHEN} value={filters.when} onChange={(when) => set({ when })} />
      </View>
      <View style={[styles.pad, styles.filterRow]}>
        <View style={styles.filterChips}>
          <Chip label={areaLabel(areas.data, filters.governorate, filters.district)} onPress={() => setAreaOpen(true)}
                icon={<Icon name="pin" size={16} color={color.muted} />} />
          <Chip label={myLevel != null ? `My level (${myLevel})` : "My level"} selected={filters.myLevel}
                icon={<Icon name="check" size={16} color={filters.myLevel ? color.onDark : color.muted} strokeWidth={2.2} />}
                onPress={() => set({ myLevel: !filters.myLevel })} />
        </View>
        {active > 0 ? (
          <View style={styles.clearRow}>
            <Text variant="caption">{`Filters · ${active}`}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Clear filters" onPress={() => setFilters(DEFAULT_FILTERS)} style={styles.clear}>
              <Text style={styles.clearText}>Clear</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {levelNote ? <Text variant="caption" style={styles.pad}>{levelNote}</Text> : null}
      {board.load.kind === "ready" ? (
        <View style={[styles.pad, styles.meta]} accessibilityLiveRegion="polite">
          <View style={styles.metaLeft}>
            <View style={[styles.dot, { backgroundColor: board.load.stale ? color.muted : color.cedar }]} />
            <Text variant="caption">{!online ? `Offline · games as of ${clock(board.updatedAt)}` : board.load.stale ? `Couldn't refresh · games as of ${clock(board.updatedAt)}` : `Updated ${clock(board.updatedAt)}`}</Text>
          </View>
          <Text variant="caption">{board.rows.length === 1 ? "1 open game" : `${board.rows.length} open games`}</Text>
        </View>
      ) : null}
    </View>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [filters, areas.data, levels.data, board.load, board.rows.length, board.updatedAt, online, active, myLevel, levelNote, suspended]);

  if (session.status === "signed-out") {
    return (
      <View style={styles.page}>
        <Stack.Screen options={{ title: "", headerRight: undefined }} />
        <View style={styles.header}><Text variant="title" accessibilityRole="header" style={styles.title}>Find a game</Text></View>
        <SignInPrompt title="Sign in to find a game" body="Games that need players are shown to signed-in players, with your level next to each one." />
      </View>
    );
  }

  const body = (() => {
    switch (board.load.kind) {
      case "loading": return <Loading label="Loading games" />;
      case "offline-empty": return <Empty title="You're offline" body="Connect to the internet to see games." />;
      case "error": return <ErrorState error={board.load.failure} onRetry={() => void board.refetch()} />;
      case "ready":
        return active > 0
          ? <Empty title="No games match these filters" body="Try another day, area or sport." action="Clear filters" onAction={() => setFilters(DEFAULT_FILTERS)} />
          : <Empty title="No open games right now" body="New games appear here as players post them." {...(GAME_WRITES_AVAILABLE ? { action: "Post a game", onAction: openPost } : {})} />;
      default: return null;
    }
  })();

  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: "", headerRight: GAME_WRITES_AVAILABLE ? () => <PostAction onPress={openPost} /> : undefined }} />
      <FlatList
        data={board.rows}
        keyExtractor={(r) => r.match_id}
        ListHeaderComponent={header}
        ListEmptyComponent={body ?? undefined}
        ListFooterComponent={cap ? <Text variant="caption" style={styles.cap}>{cap}</Text> : undefined}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
        renderItem={({ item }) => (
          <View style={styles.pad}>
            <GameCard row={item} onPress={() => router.push({ pathname: "/game/[id]", params: { id: item.match_id } })} />
          </View>
        )}
        refreshControl={<RefreshControl refreshing={board.refreshing} onRefresh={() => void board.refetch()} tintColor={color.cedar} />}
      />
      <AreaSheet
        visible={areaOpen} areas={areas.data} governorate={filters.governorate} district={filters.district}
        onClose={() => setAreaOpen(false)}
        onChoose={(governorate, district) => { set({ governorate, district }); setAreaOpen(false); }}
      />
    </View>
  );
}

const openPost = () => router.push("/games/post");

/** "Post a game" in the header (04-ux-spec.md §4.3 header: green text action). */
function PostAction({ onPress }: { onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Post a game" onPress={onPress} hitSlop={8}
               style={({ pressed }) => [styles.postAction, pressed && { opacity: 0.6 }]} testID="post-a-game">
      <Icon name="plus" size={18} color={color.cedarDeep} strokeWidth={2.4} />
      <Text style={styles.postActionText} maxFontSizeMultiplier={1.3}>Post a game</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  postAction: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: TOUCH, paddingHorizontal: space.xs },
  postActionText: { fontFamily: font.semibold, fontSize: 16, color: color.cedarDeep },
  page: { flex: 1, backgroundColor: color.ground },
  list: { paddingBottom: 48 },
  header: { gap: space.md, paddingTop: space.sm, paddingBottom: space.md },
  title: { paddingHorizontal: space.xl, textTransform: "uppercase" },
  pad: { paddingHorizontal: space.xl },
  sports: { gap: space.sm, paddingHorizontal: space.xl, paddingVertical: 2 },
  filterRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: space.sm, rowGap: space.sm },
  filterChips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, flexShrink: 1 },
  clearRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  clear: { minHeight: TOUCH, minWidth: TOUCH, justifyContent: "center", alignItems: "center", paddingHorizontal: space.sm },
  clearText: { fontFamily: font.semibold, fontSize: 15, color: color.cedar },
  meta: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  metaLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  cap: { paddingHorizontal: space.xl, paddingTop: space.lg, textAlign: "center" },
});
