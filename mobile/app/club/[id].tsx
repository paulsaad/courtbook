import { useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
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
import { BEIRUT, useDaySlots, useQuote } from "../../lib/queries";
import { bookingDays, shortDate, sportName } from "../../lib/days";
import { color, font, radius, space } from "../../lib/theme";

/**
 * A club's availability, times first (approved design 3). Every free/not-free state comes from
 * club_day_slots; the total comes from quote_price for the exact court, start and duration.
 * Reserving is not wired in this update: it lands with the retry-safe reserve step (G2).
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

  const quote = useQuote(court?.id ?? null, tile ? tile.start : null, dur);
  const name = club?.name ?? p.name ?? "Club";
  const groups = groupTiles(tiles, club?.timezone ?? BEIRUT);

  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: name, headerBackTitle: "Courts" }} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: tile ? 300 : 40 }}
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

        {q.isPending ? (
          <Loading label="Loading times" />
        ) : q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !club || tiles.every((t) => t.freeCourts.length === 0) ? (
          <Empty title="Nothing free on this day" body="Try another day, or a shorter time." />
        ) : (
          groups.map((g) => (
            <View key={g.label} style={styles.group}>
              <Text variant="heading" style={styles.groupTitle}>{g.label}</Text>
              <View style={styles.grid}>
                {g.tiles.map((t) => (
                  <View key={t.start} style={styles.cell}>
                    <TimeTile
                      time={hhmm(t.start, club.timezone)}
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
                <Chip key={c.id} label={c.name} selected={c.id === court.id} onPress={() => setCourtId(c.id)} />
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
              {quote.isSuccess ? (
                <Text style={styles.total} accessibilityLabel={`Total ${quote.data} dollars`}>${quote.data}</Text>
              ) : quote.isError ? (
                <Text variant="caption" style={{ color: color.danger }}>Price unavailable</Text>
              ) : (
                <Text variant="caption">Getting price…</Text>
              )}
              <Text variant="caption">court price</Text>
            </View>
          </View>
          <Button label="Reserving arrives in the next update" variant="secondary" disabled onPress={() => {}} />
        </View>
      )}
    </View>
  );
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
});
