import type { ReactNode } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { router, Stack } from "expo-router";
import { Text } from "../components/Text";
import { Icon } from "../components/Icon";
import { Empty, ErrorState, Loading } from "../components/StateView";
import { SignInPrompt } from "../components/SignInPrompt";
import { useSession } from "../lib/session";
import { kindIcon, relativeTime, useActivity, type Notice } from "../lib/activity";
import { color, font, radius, space, TOUCH } from "../lib/theme";

/**
 * Activity (§4.7): the player's own notices, newest first. A row opens its game. Unread rows are bold
 * with a leading dot (two signals, not colour alone). Read-only in this step: opening the list does
 * not mark anything read and nothing can be deleted from the app yet (the website still can).
 */
export default function Activity() {
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const q = useActivity({ signedIn });
  const page = (body: ReactNode) => <View style={styles.page}><Stack.Screen options={{ title: "Activity" }} />{body}</View>;

  if (session.status === "signed-out") return page(<SignInPrompt title="Your activity" body="Sign in to see requests, messages and changes to your games." />);
  if (q.isPending) return page(<Loading label="Loading activity" />);
  if (q.isError && !q.data) return page(<ErrorState error={q.error} onRetry={() => void q.refetch()} />);
  const rows = q.data ?? [];
  return page(
    <FlatList
      data={rows}
      keyExtractor={(n) => n.id}
      contentContainerStyle={styles.list}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      ListEmptyComponent={<Empty title="Nothing here yet" body="Join requests, messages and changes to your games show up here." action="Find a game" onAction={() => router.push("/games")} />}
      renderItem={({ item }) => <ActivityRow n={item} />}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={color.cedar} />}
    />,
  );
}

export function ActivityRow({ n, now }: { n: Notice; now?: Date }) {
  const unread = !n.read_at;
  const when = relativeTime(n.created_at, now);
  const inner = (
    <>
      <View style={[styles.dot, { opacity: unread ? 1 : 0 }]} />
      <View style={styles.icon}><Icon name={kindIcon(n.kind)} size={20} color={color.cedarDeep} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.body, unread && styles.bodyUnread]}>{n.body}</Text>
        <Text variant="caption">{when}</Text>
      </View>
      {n.match_id ? <Icon name="chevronRight" size={20} color={color.muted} /> : null}
    </>
  );
  const label = `${unread ? "Unread. " : ""}${n.body}, ${when}`;
  return n.match_id ? (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Opens the game"
               onPress={() => router.push({ pathname: "/game/[id]", params: { id: n.match_id! } })}
               style={({ pressed }) => [styles.row, unread && styles.rowUnread, pressed && { opacity: 0.85 }]} testID={`notice-${n.id}`}>
      {inner}
    </Pressable>
  ) : (
    <View accessible accessibilityLabel={label} style={[styles.row, unread && styles.rowUnread]} testID={`notice-${n.id}`}>{inner}</View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  list: { padding: space.lg, paddingBottom: 48 },
  sep: { height: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 16, padding: space.md, backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line },
  rowUnread: { borderColor: "#BFDFCB" },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.cedar },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: color.cedarSoft },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: color.ink },
  bodyUnread: { fontFamily: font.semibold },
});
