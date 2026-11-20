import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Text } from "../../components/Text";
import { KeyboardAware } from "../../components/KeyboardAware";
import { Button } from "../../components/Button";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { Field, JoinModeField, LevelRangeField, NoteField, Stepper } from "../../components/game/GameFields";
import { useSession } from "../../lib/session";
import { useOnline } from "../../lib/online";
import { useGame } from "../../lib/games";
import { gameWhen } from "../../lib/gameFormat";
import { sportName } from "../../lib/days";
import { GAME_WRITES_AVAILABLE, useGameActions, type GameEdit } from "../../lib/gameActions";
import { editLimits, editNote } from "../../lib/gameEdit";
import { MAX_PLAYERS, NOTE_MAX } from "../../lib/postGame";
import { color, space } from "../../lib/theme";

const playersUnit = (n: number) => (n === 1 ? "player needed" : "players needed");

/**
 * Edit game (J7 "Edit details", update_match): players needed, level range, how players join, note —
 * the fields update_match takes; club, sport and time are not editable (as on the website). The same
 * fields and wording as Post a game. update_match decides: not after the start or a cancel, never
 * below the players already accepted, and switching Ask to join → Join straight away accepts waiting
 * requests in the order they asked, up to the places left (S15).
 */
export default function EditGame() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const online = useOnline();
  const game = useGame(id, { signedIn });
  const actions = useGameActions(id ?? "", { available: GAME_WRITES_AVAILABLE });
  const [e, setE] = useState<GameEdit | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const d = game.data;

  useEffect(() => {
    if (d && !e) setE({ playersNeeded: d.players_needed, levelMin: d.level_min, levelMax: d.level_max, note: d.note ?? "", joinMode: d.join_mode });
  }, [d, e]);

  const page = (body: React.ReactNode) => <View style={styles.page}><Stack.Screen options={{ title: "Edit game" }} />{body}</View>;
  if (session.status === "signed-out") return page(<SignInPrompt title="Sign in to edit your game" body="Only the organiser can edit a game." />);
  if (!GAME_WRITES_AVAILABLE) return page(<Empty title="Not in the app yet" body="Managing games from the app arrives in the next update." />);
  if (game.isPending) return page(<Loading label="Loading the game" />);
  if (game.error) return page(<ErrorState error={game.error} onRetry={() => void game.refetch()} />);
  if (!d || !d.i_organize) return page(<Empty title="Game not available" body="Only the organiser can edit a game." />);
  const lim = editLimits(d);
  if (!lim.editable) return page(<Empty title="This game can't be edited" body={lim.reason ?? undefined} />);
  if (!e) return page(<Loading label="Loading the game" />);

  const set = (p: Partial<GameEdit>) => { setE({ ...e, ...p }); setProblem(null); };
  const busy = actions.busy({ kind: "edit", edit: e });
  const unchanged = e.playersNeeded === d.players_needed && e.levelMin === d.level_min && e.levelMax === d.level_max
    && (e.note ?? "").trim() === (d.note ?? "") && e.joinMode === d.join_mode;
  const save = async () => {
    const out = await actions.run({ kind: "edit", edit: { ...e, note: (e.note ?? "").trim() === "" ? null : (e.note ?? "").trim() } });
    if (out.kind === "done") { router.back(); return; }
    if (out.kind === "signed-out") { router.push("/sign-in"); return; }
    // refused or uncertain: the game was re-read; saving the same values again is safe (update_match sets, never adds)
    setProblem(out.kind === "uncertain" ? "We couldn't confirm the change. The game has been refreshed — check it, then save again if needed." : out.failure.message);
  };

  return page(
    <KeyboardAware>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" testID="edit-game">
        <Text variant="secondary" testID="edit-summary">{(() => { const w = gameWhen(d.start_at, d.end_at, d.club_timezone ?? undefined); return [sportName(d.sport), w.day, w.time, d.club_name].filter(Boolean).join(" · "); })()}</Text>
        <Field label="Players needed" hint={lim.minPlayers > 1 ? `Not counting you. ${d.joined} already in, so at least ${lim.minPlayers}.` : "Not counting you."}>
          <Stepper value={e.playersNeeded} min={lim.minPlayers} max={MAX_PLAYERS} onChange={(n) => set({ playersNeeded: n })} label="Players needed" unit={playersUnit} testID="players" />
        </Field>
        <LevelRangeField min={e.levelMin} max={e.levelMax} onChange={(levelMin, levelMax) => set({ levelMin, levelMax })} />
        <JoinModeField value={e.joinMode} onChange={(joinMode) => set({ joinMode })} note={editNote(d, e)} />
        <NoteField value={e.note ?? ""} onChange={(note) => set({ note })} max={NOTE_MAX} />
        <View style={styles.footer}>
          {problem ? <Text style={styles.problem} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="edit-problem">{problem}</Text> : null}
          <Button label="Save changes" busy={busy} disabled={unchanged || !online} onPress={() => void save()} testID="edit-save" />
          {!online ? <Text variant="secondary">You're offline. Connect to save changes.</Text> : null}
        </View>
      </ScrollView>
    </KeyboardAware>,
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
  footer: { gap: space.md, paddingTop: space.sm },
  problem: { color: color.danger },
});
