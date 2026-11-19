import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Text } from "../Text";
import { Empty, ErrorState, Loading } from "../StateView";
import { SignInPrompt } from "../SignInPrompt";
import { GameCard } from "./GameCard";
import { CLUB_GAMES_DAYS, loadView, useClubGames } from "../../lib/games";
import { useOnline } from "../../lib/online";
import { color, space } from "../../lib/theme";
import type { ClubGameRow, OpenGameRow } from "../../lib/gameTypes";

/**
 * The label a club-games card wears instead of the join mode: the player's own part in the game or
 * the game's state (match_board also returns the player's own full, private and paused games).
 */
export function clubGameLabel(r: ClubGameRow): string | undefined {
  if (r.i_organize) return "Organiser";
  if (r.my_status === "accepted") return "Joined";
  if (r.my_status === "pending") return "Requested";
  if (r.status === "closed") return r.closed_reason === "full" ? "Full" : r.closed_reason === "no_court" ? "Court cancelled" : "Private";
  return undefined;
}

/** match_board's row in the board card's shape (it has no town; the club is on screen already). */
export function asCardRow(r: ClubGameRow): OpenGameRow {
  return { ...r, town: null, i_joined: r.my_status === "accepted" || r.my_status === "pending" };
}

/**
 * Club → Games: this club's open games and the player's own, the next CLUB_GAMES_DAYS days
 * (match_board, under the player's session). Read-only; each card opens the game.
 */
export function ClubGames({ clubId, signedIn, bottom }: { clubId: string; signedIn: boolean; bottom: number }) {
  const online = useOnline();
  const q = useClubGames(clubId, { signedIn });
  const load = loadView({ signedIn, online, hasData: q.data !== undefined, isPending: q.isPending, fetchStatus: q.fetchStatus, error: q.error });
  if (load.kind === "signed-out") return <SignInPrompt title="Sign in to see games here" body="Games at this club are shown to signed-in players." />;
  if (load.kind === "loading") return <Loading label="Loading games" />;
  if (load.kind === "offline-empty") return <Empty title="You're offline" body="Connect to the internet to see games." />;
  if (load.kind === "error") return <ErrorState error={load.failure} onRetry={() => void q.refetch()} />;
  const rows = q.data ?? [];
  return (
    <ScrollView contentContainerStyle={[styles.list, { paddingBottom: bottom + space.xxxl }]}
                refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={color.cedar} />}>
      <Text variant="caption">{`Open games and yours, the next ${CLUB_GAMES_DAYS} days`}</Text>
      {rows.length === 0 ? (
        <Empty title="No games at this club yet" body="See games at every club on Find a game." action="Find a game" onAction={() => router.push("/games")} />
      ) : rows.map((r) => (
        <View key={r.match_id}>
          <GameCard row={asCardRow(r)} label={clubGameLabel(r)} onPress={() => router.push({ pathname: "/game/[id]", params: { id: r.match_id } })} />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({ list: { padding: space.lg, gap: space.md } });
