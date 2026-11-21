import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { PendingReservationBanner } from "../../components/PendingReservation";
import { router } from "expo-router";
import { formatInTimeZone } from "date-fns-tz";
import { hhmm } from "@shared/time";
import { useSession } from "../../lib/session";
import { rowStatus, splitAgenda, useAgenda, type AgendaRow, type RowTone } from "../../lib/bookings";
import { Text } from "../../components/Text";
import { Icon } from "../../components/Icon";
import { Segmented } from "../../components/Segmented";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { color, font, radius, space } from "../../lib/theme";

/**
 * The player's own courts and games, from my_agenda (the same list the website shows). Upcoming
 * first, soonest at the top; cancelled and finished ones under Past.
 */
export default function Bookings() {
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const q = useAgenda(signedIn);
  const [view, setView] = useState<"booking" | "match">("booking");

  if (session.status === "loading") return <Loading label="Checking sign-in" />;
  if (!signedIn) return <SignInPrompt title="Your bookings live here" body="Sign in to see your courts and the games you've joined." />;
  if (q.isPending) return <Loading label="Loading your bookings" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;

  const { upcoming, past } = splitAgenda(q.data.filter((r) => r.kind === view));

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={color.cedar} />}
    >
      <PendingReservationBanner />
      <Segmented options={[{ key: "booking", label: "Courts" }, { key: "match", label: "Games" }]} value={view} onChange={setView} />
      {upcoming.length === 0 && past.length === 0 ? (
        view === "booking" ? (
          <Empty title="No bookings yet" body="Courts you reserve show up here." action="Find a court" onAction={() => router.navigate("/courts")} />
        ) : (
          <Empty title="No games yet" body="Games you organise or join show up here." action="Find a game" onAction={() => router.push("/games")} />
        )
      ) : (
        <>
          <Text variant="eyebrow">Upcoming</Text>
          {upcoming.length === 0 ? <Text variant="secondary">Nothing coming up.</Text> : upcoming.map((r) => <Row key={r.id} r={r} />)}
          {past.length > 0 && (
            <>
              <Text variant="eyebrow" style={{ marginTop: space.md }}>Past and cancelled</Text>
              {past.map((r) => <Row key={r.id} r={r} past />)}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

export function Row({ r, past = false, now }: { r: AgendaRow; past?: boolean; now?: number }) {
  const date = formatInTimeZone(new Date(r.start_at), r.timezone, "EEE d MMM");
  const time = `${hhmm(r.start_at, r.timezone)}${r.end_at ? `–${hhmm(r.end_at, r.timezone)}` : ""}`;
  const status = rowStatus(r, now);
  const tone = TONE[status.tone];
  const label = [date, time, r.club_name, r.title, status.label].filter(Boolean).join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={r.kind === "match" ? "Opens the game" : "Opens the booking"}
      onPress={() => r.kind === "match"
        ? router.push({ pathname: "/game/[id]", params: { id: r.id } })
        : router.push({ pathname: "/booking/[id]", params: { id: r.id } })}
      style={({ pressed }) => [styles.row, past && styles.rowPast, pressed && { opacity: 0.85 }]}
    >
      <View testID="row-edge" style={[styles.edge, { backgroundColor: tone.edge }]} />
      <View style={styles.when}>
        <Text style={[styles.date, { color: tone.date }]}>{date.toUpperCase()}</Text>
        <Text style={styles.time} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{time}</Text>
      </View>
      <View style={{ flex: 1, gap: 4, alignItems: "flex-start" }}>
        {/* No line limit: the club name wraps in full at the largest text sizes (F2). */}
        <Text variant="strong">{r.club_name}</Text>
        <Text variant="secondary" numberOfLines={1}>{r.title ?? "Court"}</Text>
        <View testID="row-status" style={[styles.chip, { backgroundColor: tone.fill }]}>
          <Text variant="caption" style={{ fontFamily: font.semibold, color: tone.text }}>{status.label}</Text>
        </View>
      </View>
      <Icon name="chevronRight" size={20} color={color.muted} />
    </Pressable>
  );
}

/** Colour per state; the word in the chip always says the same thing (contrast ≥ 5.7:1). */
export const TONE: Record<RowTone, { edge: string; date: string; fill: string; text: string }> = {
  confirmed: { edge: color.cedar, date: color.cedarDeep, fill: color.cedarSoft, text: color.cedarDeep },
  waiting: { edge: color.warnInk, date: color.warnInk, fill: color.warnSoft, text: color.warnInk },
  cancelled: { edge: color.danger, date: color.danger, fill: color.dangerSoft, text: color.danger },
  past: { edge: color.line, date: color.muted, fill: color.ground, text: color.muted },
};

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.md, paddingBottom: 40 },
  row: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 76, paddingRight: space.lg,
    backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, overflow: "hidden",
  },
  rowPast: { backgroundColor: "#FAF8F3" },
  edge: { width: 5, alignSelf: "stretch" },
  chip: { borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 2 },
  // Grows with large text so a time range is never split mid-number ("10:30–1 / 2:00", Android 1.6×).
  when: { minWidth: 96, maxWidth: "45%", gap: 2, paddingVertical: space.md },
  date: { fontFamily: font.bold, fontSize: 14, letterSpacing: 0.6 },
  time: { fontFamily: font.score, fontSize: 18, color: color.ink },
});
