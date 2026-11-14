import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View, type HostInstance, type ScrollViewInstance } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
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
import { Segmented } from "../../components/Segmented";
import { ClubInfoView } from "../../components/ClubInfoView";
import { useClubInfo } from "../../lib/clubInfo";
import { PendingReservationBanner } from "../../components/PendingReservation";
import { clubsFromSlots, durationLabel, durationOptions, partOfDay, sameInstant, tilesFor } from "../../lib/courts";
import { BEIRUT, money, tilePriceLabel, useClubMode, useDaySlots, useQuote, useTilePrices } from "../../lib/queries";
import { useSession } from "../../lib/session";
import { useReservation } from "../../lib/reservation";
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
  const p = useLocalSearchParams<{ id: string; name?: string; date?: string; sport?: string; at?: string; tab?: string }>();
  const insets = useSafeAreaInsets();
  const days = useMemo(() => bookingDays(BEIRUT), []);
  const [date, setDate] = useState(p.date ?? days[0].key);
  const sport = p.sport ?? null;
  const q = useDaySlots(date, sport);
  const club = useMemo(() => clubsFromSlots(q.data ?? []).find((c) => c.id === p.id), [q.data, p.id]);
  // Book | Info. The club's details are read on their own, so they show even on a day with nothing free.
  const [tab, setTab] = useState<"book" | "info">(p.tab === "info" ? "info" : "book");
  const info = useClubInfo(p.id ?? null);
  const infoClub = info.data?.club;
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

  const session = useSession();
  const queryClient = useQueryClient();
  const mode = useClubMode(club?.id ?? null);
  const res = useReservation({
    clubId: p.id ?? null,
    onReserved: (bookingId) => {
      haptic.success();
      void queryClient.invalidateQueries({ queryKey: ["my-agenda"] });
      void queryClient.invalidateQueries({ queryKey: ["day-slots"] });
      router.replace({ pathname: "/booking/[id]", params: { id: bookingId, new: "1" } });
    },
  });
  // While a reservation is in flight or unconfirmed, nothing the player sent can change.
  const locked = res.locked;

  // A selection that is no longer free after a refresh is dropped, and the player is told — but
  // never while a reservation is out: the slot may have gone to this very player.
  useEffect(() => {
    if (locked || !start || !q.isSuccess || !club) return;
    if (!tile || tile.freeCourts.length === 0) {
      setStart(null);
      setNotice(`${hhmm(start, club.timezone)} is no longer free for ${durationLabel(dur ?? 0)}. Pick another time.`);
    }
  }, [locked, tile, start, q.isSuccess, club, dur]);

  const prices = useTilePrices(club?.id ?? null, dur, tiles);
  const quote = useQuote(court?.id ?? null, tile ? tile.start : null, dur);
  const livePrice = (tile && court && prices.data?.get(tile.start)?.get(court.id)?.price) ?? (quote.isSuccess ? quote.data : null);
  const selKey = tile && court && dur ? `${court.id}|${tile.start}|${dur}` : "";
  useEffect(() => res.clearProblem(), [selKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the panel shows: the frozen selection while one is out, otherwise the live one.
  const shown =
    res.pending ??
    (tile && court && dur && club
      ? { date, start: tile.start, minutes: dur, courtId: court.id, courtName: court.name, price: livePrice ?? null }
      : null);

  const scroller = useRef<ScrollViewInstance | null>(null);
  const content = useRef<HostInstance | null>(null);
  const cells = useRef(new Map<string, HostInstance | null>());
  const groupY = useRef<Record<string, number>>({});
  const scrollY = useRef(0);
  const viewport = useRef(0);

  // The panel sits below the list (not over it), so the list ends where the panel begins. When the
  // panel appears or grows, the list gets shorter; this keeps the chosen time in view.
  const reveal = useCallback(() => {
    const cell = tile ? cells.current.get(tile.start) : null;
    if (!cell || !content.current) return;
    cell.measureLayout(content.current, (_x: number, y: number, _w: number, h: number) => {
      const margin = 12;
      if (y + h + margin > scrollY.current + viewport.current) {
        scroller.current?.scrollTo({ y: y + h + margin - viewport.current, animated: true });
      } else if (y - margin < scrollY.current) {
        scroller.current?.scrollTo({ y: Math.max(0, y - margin), animated: true });
      }
    }, () => {});
  }, [tile]);
  useEffect(() => {
    const id = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(id);
  }, [tile?.start, reveal]);

  const name = club?.name ?? infoClub?.name ?? p.name ?? "Club";
  const town = club?.town ?? infoClub?.town?.name_en ?? null;
  const cutoff = club?.cancelCutoffHours ?? infoClub?.cancel_cutoff_hours ?? null;
  const isDemo = club?.isDemo ?? infoClub?.is_demo ?? false;

  function onReserve() {
    if (!tile || !court || !dur || !club || locked || res.blockedBy) return;
    if (session.status !== "signed-in") {
      router.push({ pathname: "/sign-in" });
      return;
    }
    void res.submit({
      key: selKey, mode: mode.data ?? "", clubId: club.id, clubName: club.name, timezone: club.timezone,
      courtId: court.id, courtName: court.name, date, start: tile.start, minutes: dur, price: livePrice ?? null,
    });
  }

  const atDesk = mode.data === "at_desk";
  const reserveLabel =
    res.phase === "sending" ? "Reserving…"
    : res.phase === "checking" ? "Checking…"
    : res.phase === "uncertain" ? "Check now"
    : session.status !== "signed-in" ? "Sign in to reserve"
    : res.blockedBy ? "Earlier booking not confirmed"
    : mode.isPending ? "Checking the club…"
    : !atDesk ? "Reserve on the website for now"
    : "Reserve court";
  const groups = groupTiles(tiles, club?.timezone ?? BEIRUT);
  const tz = club?.timezone ?? res.pending?.timezone ?? BEIRUT;

  return (
    <View style={styles.page}>
      <Stack.Screen options={{ title: name, headerBackTitle: "Courts" }} />
      <View style={styles.tabs}>
        <Segmented
          options={[{ key: "book", label: "Book" }, { key: "info", label: "Info" }]}
          value={tab}
          onChange={(k) => { if (!locked) setTab(k); }}
        />
      </View>
      {tab === "info" ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl }}
          refreshControl={<RefreshControl refreshing={info.isRefetching} onRefresh={() => void info.refetch()} tintColor={color.cedar} />}
        >
          <ClubInfoView query={info} onBook={() => setTab("book")} />
        </ScrollView>
      ) : (
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: space.xxl }}
        scrollEventThrottle={32}
        onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}
        onLayout={(e) => { viewport.current = e.nativeEvent.layout.height; reveal(); }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={color.cedar} />}
      >
        <View ref={content} collapsable={false}>
        {res.blockedBy && <PendingReservationBanner style={{ marginHorizontal: 16, marginTop: 12 }} />}
        <View style={styles.head}>
          {(town || cutoff !== null) && (
            <Text variant="secondary">
              {[town, sport ? sportName(sport) : null, cutoff !== null ? `Free cancellation up to ${cutoff} h before` : null].filter(Boolean).join(" · ")}
            </Text>
          )}
          {isDemo && <Text style={styles.demo}>Demo club — not a real venue</Text>}
        </View>
        <View style={styles.pickers}>
          <DateStrip days={days} selected={date} disabled={locked} onSelect={(d) => { if (locked) return; setDate(d); setStart(null); setNotice(null); }} />
          {durations.length > 0 && (
            <View style={styles.durRow}>
              <Text variant="secondary">Play for</Text>
              {durations.slice(0, 4).map((m) => (
                <Chip key={m} label={durationLabel(m)} selected={m === dur} disabled={locked} onPress={() => { if (locked) return; setMinutes(m); setNotice(null); }} />
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
                  <View key={t.start} style={styles.cell} collapsable={false} ref={(v) => { cells.current.set(t.start, v); }}>
                    <TimeTile
                      time={hhmm(t.start, club.timezone)}
                      price={tilePriceLabel(prices.data?.get(t.start))}
                      freeCourts={t.freeCourts.length}
                      selected={sameInstant(t.start, start)}
                      disabled={locked}
                      onPress={() => { if (locked) return; setStart(t.start); setCourtId(null); setNotice(null); }}
                    />
                  </View>
                ))}
              </View>
            </View>
          ))
        )}
        </View>
      </ScrollView>
      )}

      {tab === "book" && shown && (club || res.pending) && (
        <View testID="booking-panel" style={[styles.panel, { paddingBottom: insets.bottom + 14 }]}>
          <View style={styles.courtRow} accessibilityRole="radiogroup">
            <Text variant="label" style={{ marginRight: 10, flexShrink: 0 }} numberOfLines={1}>Court</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {locked ? (
                <Chip label={shown.courtName} selected disabled onPress={() => {}} />
              ) : (
                freeCourts.map((c) => (
                  <Chip key={c.id} label={courtLabel(c, tile ? prices.data?.get(tile.start) : undefined)} selected={c.id === shown.courtId} onPress={() => setCourtId(c.id)} />
                ))
              )}
            </ScrollView>
          </View>
          {!locked && freeCourts.length === 1 && <Text variant="caption">The only court free at this time.</Text>}
          <View style={styles.summaryRow}>
            <View style={{ flexShrink: 1 }}>
              <Text variant="strong">{shortDate(shown.date)} · {hhmm(shown.start, tz)}–{hhmm(new Date(Date.parse(shown.start) + shown.minutes * 60_000), tz)}</Text>
              <Text variant="secondary">{[sport ? sportName(sport) : null, shown.courtName, durationLabel(shown.minutes)].filter(Boolean).join(" · ")}</Text>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              {shown.price !== null ? (
                <Text style={styles.total} accessibilityLabel={`Total ${shown.price} dollars`}>{money(shown.price)}</Text>
              ) : quote.isError ? (
                <Text variant="caption" style={{ color: color.danger }}>Price unavailable</Text>
              ) : (
                <Text variant="caption">Getting price…</Text>
              )}
              <Text variant="caption">{atDesk ? "pay at the club" : "court price"}</Text>
            </View>
          </View>
          {res.problem ? (
            <Text style={res.phase === "idle" && !res.blockedBy ? styles.problem : styles.pending} accessibilityRole="alert" accessibilityLiveRegion="polite">{res.problem}</Text>
          ) : atDesk ? (
            <Text variant="caption">Nothing is charged in the app.{cutoff !== null ? ` Free cancellation up to ${cutoff} h before.` : ""}</Text>
          ) : mode.isSuccess ? (
            <Text variant="caption">This club takes payment in the app. That arrives in the next update — reserve it on the website for now.</Text>
          ) : null}
          <Button
            label={reserveLabel}
            busy={res.phase === "sending" || res.phase === "checking"}
            disabled={res.phase === "idle" && session.status === "signed-in" && (!!res.blockedBy || !atDesk || shown.price === null)}
            onPress={res.phase === "uncertain" ? () => void res.check() : onReserve}
          />
        </View>
      )}
    </View>
  );
}

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
  tabs: { backgroundColor: color.card, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 10 },
  head: { backgroundColor: color.card, paddingHorizontal: 20, paddingTop: 0, paddingBottom: 8, gap: 2 },
  demo: { fontFamily: font.semibold, fontSize: 13, color: color.warnInk },
  pickers: { backgroundColor: color.card, borderBottomWidth: 1, borderBottomColor: color.line, paddingBottom: space.md, gap: space.md },
  durRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 20, flexWrap: "wrap" },
  status: { paddingHorizontal: 20, paddingTop: space.md, gap: 6 },
  notice: { fontFamily: font.semibold, fontSize: 15, color: color.warnInk },
  group: { paddingHorizontal: 20, paddingTop: space.lg },
  groupTitle: { marginBottom: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  // Three columns: 3 × 31.5% + two 8 pt gaps fit a 335 pt row (iPhone SE). At 31.8% they did not,
  // and the SE showed two columns with an empty third.
  cell: { width: "31.5%" },
  panel: { backgroundColor: color.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderTopWidth: 1, borderColor: color.line, paddingHorizontal: 20, paddingTop: 14, gap: 10 },
  courtRow: { flexDirection: "row", alignItems: "center" },
  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: 12 },
  total: { fontFamily: font.score, fontSize: 30, lineHeight: 32, color: color.ink },
  problem: { fontFamily: font.semibold, fontSize: 15, color: color.danger },
  pending: { fontFamily: font.semibold, fontSize: 15, color: color.warnInk },
  jumpRow: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingTop: space.md },
});
