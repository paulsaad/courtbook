import { useEffect } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Text } from "./Text";
import { Button } from "./Button";
import { FavouriteHeart } from "./FavouriteHeart";
import { favouritesShown, useFavourites, useFavouriteClubRows } from "../lib/favourites";
import { useDismissQuestion, usePlayingPrefs } from "../lib/playing";
import { color, font, radius, space } from "../lib/theme";

/**
 * Home, signed in (0087/0088):
 *  - "Where do you usually play?" — optional, asked once per account (answering or "Not now" both count), on any device;
 *  - "Your clubs" — every favourite, whatever the region, one tap to the club. Before the database has these, nothing
 *    is drawn.
 */
export function AreasQuestionCard({ userId }: { userId: string }) {
  const prefs = usePlayingPrefs(userId);
  const dismiss = useDismissQuestion(userId);
  if (!prefs.data || prefs.data.asked) return null;
  return (
    <View style={styles.card} testID="areas-question">
      <Text variant="heading" accessibilityRole="header">Where do you usually play?</Text>
      <Text variant="secondary">Save the areas and towns you play in — Beirut in the week, Batroun at the weekend — and they&apos;re one tap away on every device.</Text>
      <View style={styles.row}>
        <View style={{ flex: 1 }}><Button label="Choose my areas" onPress={() => router.push("/areas")} testID="areas-question-choose" /></View>
        <View style={{ flex: 1 }}><Button label="Not now" variant="secondary" disabled={dismiss.isPending} onPress={() => dismiss.mutate()} testID="areas-question-dismiss" /></View>
      </View>
      {dismiss.isError ? <Text accessibilityRole="alert" style={styles.error} testID="areas-question-error">Couldn&apos;t save that. Try again.</Text> : null}
    </View>
  );
}

export function YourClubsRow({ userId }: { userId: string }) {
  const fav = useFavourites(userId);
  const shown = favouritesShown(fav);
  const rows = useFavouriteClubRows(userId, shown);
  const ids = fav.data ?? [];
  // the row follows the hearts: a club added elsewhere is fetched again; a removed one disappears at once
  const missing = ids.some((id) => !rows.data?.some((r) => r.club_id === id));
  useEffect(() => { if (shown && missing && !rows.isFetching) void rows.refetch(); }, [shown, missing]); // eslint-disable-line react-hooks/exhaustive-deps
  const clubs = (rows.data ?? []).filter((r) => ids.includes(r.club_id));
  if (!shown || clubs.length === 0) return null;
  return (
    <View style={styles.section} testID="your-clubs">
      <Text variant="heading" accessibilityRole="header">Your clubs</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.md }}>
        {clubs.map((c) => (
          <View key={c.club_id} style={styles.club}>
            <Pressable accessibilityRole="button" accessibilityLabel={[c.name, c.town].filter(Boolean).join(", ")} style={{ flex: 1, minHeight: 48, justifyContent: "center" }}
              onPress={() => router.push({ pathname: "/club/[id]", params: { id: c.club_id, name: c.name } })}>
              <Text style={styles.clubName} numberOfLines={2}>{c.name}</Text>
              {c.town ? <Text variant="secondary" numberOfLines={1}>{c.town}</Text> : null}
            </Pressable>
            <FavouriteHeart clubId={c.club_id} clubName={c.name} userId={userId} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md, padding: space.lg, backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line },
  row: { flexDirection: "row", gap: space.md },
  section: { gap: space.md },
  club: { flexDirection: "row", alignItems: "center", gap: space.sm, width: 240, paddingLeft: space.lg, paddingVertical: space.sm, backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line },
  clubName: { fontFamily: font.bold, fontSize: 16, color: color.ink },
  error: { color: color.danger },
});
