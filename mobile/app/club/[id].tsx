import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { router, Stack, useLocalSearchParams, usePathname } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { hhmm } from "@shared/time";
import { Text } from "../../components/Text";
import { Chip } from "../../components/Chip";
import { DateStrip } from "../../components/DateStrip";
import { TimeTile } from "../../components/TimeTile";
import { Button } from "../../components/Button";
import { Freshness } from "../../components/Freshness";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { clubsFromSlots, durationLabel, durationOptions, partOfDay, sameInstant, tilesFor } from "../../lib/courts";
import { BEIRUT, money, tilePriceLabel, useClubMode, useDaySlots, useQuote, useTilePrices } from "../../lib/queries";
import { useSession } from "../../lib/session";
import { newAttempt, reserve, type Attempt } from "../../lib/reserve";
import { haptic } from "../../lib/haptics";
import { bookingDays, shortDate, sportName } from "../../lib/days";
import { color, font, radius, space } from "../../lib/theme";

/**
 * A club's availability, times first (approved design 3). Every free/not-free state comes from
 * club_day_slots; every price shown comes from quote_price for that exact court, start and
 * duration. Reserving goes through the database (book_at_desk with a retry token) — the app only
 * asks. Clubs that take payment in the app wait for the retry-safe hold (G2, migration 0065).
 */
export default function Club() {
  const p = useLocalSearchParams<{ id: string; name?: string; date?: string; sport?: string; at?: string }>();
  const insets = useSafeAreaInsets();
  const days = useMemo(() => bookingDays(BEIRUT), []);
  const [date, setDate] = useState(p.date ?? days[0].key);
  const sport = p.sport ?? null;
  const q = useDaySlots(date, sport);
  const club = useMemo(() => clubsFromSlots(q.data ?? []).find((c) => c.id === p.id), [q.data, p.id]);
  const durations = club ? durationOptions(club) : [];
  const [minutes, setMinutes] = useState<number | null>(null);
  // Arriving from a time on the Courts list: that time was listed because it is free for the club's
  // minimum, so start there; otherwise default to 1 h 30 where the club allows it.
  const dur = minutes && durations.includes(minutes) ? minutes : p.at ? durations[0] ?? null : durations.includes(90) ? 90 : durations[0] ?? null;
  const tiles = useMemo(() => (club && dur ? tilesFor(q.data ?? [], club.id, dur) : []), [q.data, club, dur]);

  const [start, setStart] = useState<string | null>(p.at ?? null);
  const [courtId, setCourtId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tile = tiles.find((t) => sameInstant(t.start, start));
  const freeCourts = tile?.freeCourts ?? [];
  const court = freeCourts.find((c) => c.id === courtId) ?? freeCourts[0] ?? null;

  // A selection that is no longer free after a refresh is dropped, and the player is told.
  useEffect(() => {
    if (!start || !q.isSuccess || !club) return;
    if (!tile || tile.freeCourts.length === 0) {
      setStart(null);
      setNotice(`${hhmm(start, club.timezone)} is no longer free for ${durationLabel(dur ?? 0)}. Pick another time.`);
    }
  }, [tile, start, q.isSuccess, club, dur]);

  const prices = useTilePrices(club?.id ?? null, dur, tiles);
  const quote = useQuote(court?.id ?? null, tile ? tile.start : null, dur);
  const panelPrice = (tile && court && prices.data?.get(tile.start)?.get(court.id)?.price) ?? (quote.isSuccess ? quote.data : null);
  const mode = useClubMode(club?.id ?? null);
  const session = useSession();
  const path = usePathname();
  const queryClient = useQueryClient();
  // One attempt per selection. A retry after an uncertain result reuses it, so the database
  // returns the same booking instead of making a second one. Any change of selection starts afresh.
  const attempt = useRef<{ key: string; a: Attempt } | null>(null);
  const [reserving, setReserving] = useState(false);
  const [problem, setProblem] = useState<{ text: string; retry: boolean } | null>(null);
  const selKey = tile && court && dur ? `${court.id}|${tile.start}|${dur}` : "";
  useEffect(() => setProblem(null), [selKey]);

  // jump between morning / afternoon / evening when the list is long
  const scroller = useRef<ScrollViewInstance | null>(null);
  const groupY = useRef<Record<string, number>>({});
  const name = club?.name ?? p.name ?? "Club";

  async function onReserve() {
    if (!tile || !court || !dur || !club) return;
    if (session.status !== "signed-in") {
      router.push({ pathname: "/sign-in", params: { returnTo: path } });
      return;
    }
    if (!attempt.current || attempt.current.key !== selKey) {
      attempt.current = {
        key: selKey,
        a: newAttempt({ mode: mode.data ?? "", clubId: club.id, courtId: court.id, start: new Date(tile.start), end: new Date(Date.parse(tile.start) + dur * 60_000) }),
      };
    }
    setReserving(true);
    setProblem(null);
    const r = await reserve(attempt.current.a);
    setReserving(false);
    void queryClient.invalidateQueries({ queryKey: ["day-slots"] });
    if (r.kind === "reserved") {
      attempt.current = null;
      haptic.success();
      void queryClient.invalidateQueries({ queryKey: ["my-agenda"] });
      router.replace({ pathname: "/booking/[id]", params: { id: r.value.bookingId, new: "1" } });
    } else if (r.kind === "refused") {
      attempt.current = null; // the database said no; a new tap is a new attempt
      setProblem({ text: r.failure.message, retry: false });
    } else {
      // The request may or may not have reached the server. Trying again with the same token is
      // safe: if the first one went through, the database hands back that same booking.
      setProblem({ text: "We couldn't hear back from the server. Your booking may or may not have gone through.", retry: true });
    }
  }

  const atDesk = mode.data === "at_desk";
  const reserveLabel =
    session.status !== "signed-in" ? "Sign in to reserve"
    : mode.isPending ? "Checking the club…"
    : !atDesk ? "Reserve on the website for now"
    : problem?.retry ? "Try again (safe)"
    : "Reserve court";
  const groups = groupTiles(tiles, club?.timezone ?? BEIRUT);

  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: name, headerBackTitle: "Courts" }} />
      <ScrollView
        ref={scroller}
        contentContainerStyle={{ paddingBottom: tile ? 340 : 40 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={color.cedar} />}
      >
        <View style={styles.head}>
          {club && (
            <Text variant="secondary">
              {[club.town, sport ? sportName(sport) : null, `Free cancellation up to ${club.cancelCutoffHours} h before`].filter(Boolean).join(" · ")}
            </Text>
          )}
          {club?.isDemo && <Text style={styles.demo}>Demo club — not a real venue</Text>}
        </View>
        <View style={styles.pickers}>
          <DateStrip days={days} selected={date} onSelect={(d) => { setDate(d); setStart(null); setNotice(null); }} />
          {durations.length > 0 && (
            <View style={styles.durRow}>
              <Text variant="secondary">Play for</Text>
              {durations.slice(0, 4).map((m) => (
                <Chip key={m} label={durationLabel(m)} selected={m === dur} onPress={() => { setMinutes(m); setNotice(null); }} />
              ))}
            </View>
          )}
        </View>

        <View style={styles.status}>
          <Freshness lastSuccessAt={q.dataUpdatedAt} fetching={q.isFetching} failedSinceSuccess={q.isError && q.dataUpdatedAt > 0} />
          {notice && <Text style={styles.notice} accessibilityRole="alert">{notice}</Text>}
        </View>
        {groups.length > 1 && tiles.length > 12 && (
          <View style={styles.jumpRow}>
            {groups.map((g) => (
              <Chip key={g.label} label={g.label} onPress={() => scroller.current?.scrollTo({ y: Math.max(0, (groupY.current[g.label] ?? 0) - 8), animated: true })} />
            ))}
          </View>
        )}

        {q.isPending ? (
          <Loading label="Loading times" />
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !club || tiles.every((t) => t.freeCourts.length === 0) ? (
          <Empty title="Nothing free on this day" body="Try another day, or a shorter time." />
        ) : (
          groups.map((g) => (
            <View key={g.label} style={styles.group} onLayout={(e) => { groupY.current[g.label] = e.nativeEvent.layout.y; }}>
              <Text variant="heading" style={styles.groupTitle}>{g.label}</Text>
              <View style={styles.grid}>
                {g.tiles.map((t) => (
                  <View key={t.start} style={styles.cell}>
                    <TimeTile
                      time={hhmm(t.start, club.timezone)}
                      price={tilePriceLabel(prices.data?.get(t.start))}
                      freeCourts={t.freeCourts.length}
                      selected={sameInstant(t.start, start)}
                      onPress={() => { setStart(t.start); setCourtId(null); setNotice(null); }}
                    />
                  </View>
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {tile && club && dur && court && (
        <View style={[styles.panel, { paddingBottom: insets.bottom + 14 }]}>
          <View style={styles.courtRow} accessibilityRole="radiogroup">
            <Text variant="label" style={{ width: 52 }}>Court</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {freeCourts.map((c) => (
                <Chip key={c.id} label={courtLabel(c, prices.data?.get(tile.start))} selected={c.id === court.id} onPress={() => setCourtId(c.id)} />
              ))}
            </ScrollView>
          </View>
          {freeCourts.length === 1 && <Text variant="caption">The only court free at this time.</Text>}
          <View style={styles.summaryRow}>
            <View style={{ flexShrink: 1 }}>
              <Text variant="strong">{shortDate(date)} · {hhmm(tile.start, club.timezone)}–{hhmm(new Date(Date.parse(tile.start) + dur * 60_000), club.timezone)}</Text>
              <Text variant="secondary">{[sport ? sportName(sport) : null, court.name, durationLabel(dur)].filter(Boolean).join(" · ")}</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              {panelPrice !== null && panelPrice !== undefined ? (
                <Text style={styles.total} accessibilityLabel={`Total ${panelPrice} dollars`}>{money(panelPrice)}</Text>
              ) : quote.isError ? (
                <Text variant="caption" style={{ color: color.danger }}>Price unavailable</Text>
              ) : (
                <Text variant="caption">Getting price…</Text>
              )}
              <Text variant="caption">{atDesk ? "pay at the club" : "court price"}</Text>
            </View>
          </View>
          {atDesk && <Text variant="caption">Nothing is charged in the app. Free cancellation up to {club.cancelCutoffHours} h before.</Text>}
          {mode.isSuccess && !atDesk && (
            <Text variant="caption">This club takes payment in the app. That arrives in the next update — reserve it on the website for now.</Text>
          )}
          {problem && <Text style={styles.problem} accessibilityRole="alert">{problem.text}</Text>}
          <Button
            label={reserveLabel}
            busy={reserving}
            disabled={session.status === "signed-in" && (!atDesk || panelPrice === null || panelPrice === undefined)}
            onPress={onReserve}
          />
        </View>
      )}
    </View>
  );
}

/** Court name, plus its price when the free courts at this time are not all the same price. */
function courtLabel(c: { id: string; name: string }, prices: Map<string, { price: number | null }> | undefined) {
  const known = prices ? [...prices.values()].map((p) => p.price).filter((p): p is number => p !== null) : [];
  const mine = prices?.get(c.id)?.price;
  return known.length > 1 && new Set(known).size > 1 && mine != null ? `${c.name} · ${money(mine)}` : c.name;
}

function groupTiles<T extends { start: string }>(tiles: T[], tz: string) {
  const out: { label: string; tiles: T[] }[] = [];
  for (const t of tiles) {
    const label = partOfDay(Number(hhmm(t.start, tz).slice(0, 2)));
    const g = out[out.length - 1];
    if (g && g.label === label) g.tiles.push(t);
    else out.push({ label, tiles: [t] });
  }
  return out;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  head: { backgroundColor: color.card, paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8, gap: 2 },
  demo: { fontFamily: font.semibold, fontSize: 13, color: color.warnInk },
  pickers: { backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.line, paddingBottom: space.md, gap: space.md },
  durRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, flexWrap: "wrap" },
  status: { paddingHorizontal: 20, paddingTop: space.md, gap: 6 },
  notice: { fontFamily: font.semibold, fontSize: 15, color: color.warnInk },
  group: { paddingHorizontal: 20, paddingTop: space.lg },
  groupTitle: { marginBottom: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cell: { width: "31.8%" },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: color.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderTopWidth: 1, borderColor: color.line, paddingHorizontal: 20, paddingTop: 14, gap: 10 },
  courtRow: { flexDirection: "row", alignItems: "center" },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: 12 },
  total: { fontFamily: font.score, fontSize: 30, lineHeight: 32, color: color.ink },
  problem: { fontFamily: font.semibold, fontSize: 15, color: color.danger },
  jumpRow: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingTop: space.md },
});
