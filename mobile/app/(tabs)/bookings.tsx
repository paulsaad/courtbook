import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { formatInTimeZone } from "date-fns-tz";
import { hhmm } from "@shared/time";
import { useSession } from "../../lib/session";
import { splitAgenda, useAgenda, type AgendaRow } from "../../lib/bookings";
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
      <Segmented options={[{ key: "booking", label: "Courts" }, { key: "match", label: "Games" }]} value={view} onChange={setView} />
      {upcoming.length === 0 && past.length === 0 ? (
        view === "booking" ? (
          <Empty title="No bookings yet" body="Courts you reserve show up here." action="Find a court" onAction={() => router.navigate("/courts")} />
        ) : (
          <Empty title="No games yet" body="Games you organise or join show up here. Finding games in the app arrives in the next milestone." />
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

function Row({ r, past = false }: { r: AgendaRow; past?: boolean }) {
  const date = formatInTimeZone(new Date(r.start_at), r.timezone, "EEE d MMM");
  const time = `${hhmm(r.start_at, r.timezone)}${r.end_at ? `–${hhmm(r.end_at, r.timezone)}` : ""}`;
  const status = r.status === "cancelled" ? "Cancelled" : r.status === "no_show" ? "No-show" : null;
  const tappable = r.kind === "booking";
  const label = [date, time, r.club_name, r.title, status].filter(Boolean).join(", ");
  return (
    <Pressable
      accessibilityRole={tappable ? "button" : undefined}
      accessibilityLabel={label}
      disabled={!tappable}
      onPress={() => router.push({ pathname: "/booking/[id]", params: { id: r.id } })}
      style={({ pressed }) => [styles.row, past && styles.rowPast, pressed && { opacity: 0.85 }]}
    >
      <View style={[styles.edge, past && { backgroundColor: color.line }]} />
      <View style={styles.when}>
        <Text style={[styles.date, past && { color: color.muted }]}>{date.toUpperCase()}</Text>
        <Text style={styles.time}>{time}</Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="strong" numberOfLines={2}>{r.club_name}</Text>
        <Text variant="secondary" numberOfLines={1}>{r.title ?? "Court"}</Text>
        {status && <Text variant="caption" style={{ fontFamily: font.semibold }}>{status}</Text>}
      </View>
      {tappable && <Icon name="chevronRight" size={20} color={color.muted} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.md, paddingBottom: 40 },
  row: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 76, paddingRight: space.lg,
    backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, overflow: "hidden",
  },
  rowPast: { backgroundColor: "#FAF8F3" },
  edge: { width: 5, alignSelf: "stretch", backgroundColor: color.red },
  when: { width: 96, gap: 2, paddingVertical: space.md },
  date: { fontFamily: font.bold, fontSize: 14, letterSpacing: 0.6, color: color.red },
  time: { fontFamily: font.score, fontSize: 18, color: color.ink },
});
