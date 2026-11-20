import { useState, type ReactNode } from "react";
import { Alert, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Button } from "../../components/Button";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { GameDetailView, type DetailHandlers } from "../../components/game/GameDetailView";
import { BookingPicker } from "../../components/game/BookingPicker";
import { ManageSheet } from "../../components/game/ManageSheet";
import { useSession } from "../../lib/session";
import { SCREEN_FEATURES, useGameScreen } from "../../lib/gameScreens";
import { useActivity, useMarkRead } from "../../lib/activity";
import type { ActionOutcome, GameAction } from "../../lib/gameActions";
import { NOT_AVAILABLE, organiserActions } from "../../lib/gameState";
import { color, space } from "../../lib/theme";

/** Asks each sentence in turn (GR-10: no court, level outside the range); resolves true only if all are accepted. */
function confirmAll(sentences: string[], okLabel: string): Promise<boolean> {
  return sentences.reduce<Promise<boolean>>((prev, text) => prev.then((ok) => !ok ? false : new Promise((resolve) =>
    Alert.alert("Before you go ahead", text, [
      { text: "Not now", style: "cancel", onPress: () => resolve(false) },
      { text: okLabel, onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }))), Promise.resolve(true));
}
function confirm(title: string, text: string, okLabel: string, destructive = false): Promise<boolean> {
  return new Promise((resolve) => Alert.alert(title, text, [
    { text: "Not now", style: "cancel", onPress: () => resolve(false) },
    { text: okLabel, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}

/**
 * Game (approved Stitch exports 26–30; docs/m3/04-ux-spec.md §4.4). Reads match_detail (0067) and,
 * for the organiser and accepted players only, match_participants — both under the player's own
 * session, so the database decides what this person may see. Game actions are on only against the
 * staging database, where 0072 is applied (SCREEN_FEATURES.writes, GAME_WRITES_AVAILABLE); elsewhere
 * no handler is passed and no action control is drawn.
 */
export default function GameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const me = signedIn ? session.session.user.id : null;
  const screen = useGameScreen(id, { signedIn });
  // Opening a game marks its notices read (§5.7), as the website's Activity does.
  const activity = useActivity({ signedIn });
  useMarkRead(screen.load.kind === "ready" ? activity.data : undefined, id);
  const [picking, setPicking] = useState(false);
  const [managing, setManaging] = useState(false);
  const d = screen.detail;

  if (session.status === "signed-out") {
    return <View style={{ flex: 1 }}><Stack.Screen options={{ title: "Game" }} /><SignInPrompt title="Sign in to see this game" body="Games are shown to signed-in players." /></View>;
  }
  const page = (body: ReactNode) => <View style={{ flex: 1, backgroundColor: color.ground }}><Stack.Screen options={{ title: "Game" }} />{body}</View>;

  switch (screen.load.kind) {
    case "loading": return page(<Loading label="Loading the game" />);
    case "offline-empty": return page(<Empty title="You're offline" body="Connect to the internet to see this game." />);
    case "error": return page(<ErrorState error={screen.load.failure} onRetry={screen.refetch} />);
    case "unavailable": return page(<Empty title="Not in the app yet" body={screen.load.message} />);
    case "not-visible":
      return page(
        <View style={{ padding: space.lg }}>
          <Empty title="Game not available" body={NOT_AVAILABLE} />
          <Button label="Find a game" variant="secondary" onPress={() => router.replace("/games")} />
        </View>,
      );
    case "signed-out": return null;
    case "ready": break;
  }
  if (!d || !screen.sections) return null;

  // ---- actions: only built when the switch is on (M3-H approved and applied) ----
  const run = async (a: GameAction) => report(await screen.actions.run(a));
  const handlers: DetailHandlers = {
    onOpenClub: d.club_id && d.status !== "cancelled" ? () => router.push({ pathname: "/club/[id]", params: { id: d.club_id!, name: d.club_name ?? "", tab: "info" } }) : undefined,
  };
  if (SCREEN_FEATURES.writes) {
    const v = screen.sections.find((s) => s.kind === "actions");
    handlers.busy = (key) => key.startsWith("decide:") ? screen.actions.busy({ kind: "decide", profileId: key.slice(7), accept: true })
      : key === "join" || key === "ask" ? screen.actions.busy({ kind: "join" }) : false;
    handlers.onPrimary = async () => {
      if (v?.kind !== "actions" || !v.primary) return;
      if (v.primary.kind === "join" || v.primary.kind === "ask") {
        if (await confirmAll(v.joinConfirm, v.primary.label)) await run({ kind: "join" });
      }
    };
    handlers.onSecondary = async (s) => {
      if (s === "withdraw" && await confirm("Withdraw your request?", "The organiser will no longer see it.", "Withdraw")) await run({ kind: "leave" });
      if (s === "leave" && await confirm("Leave this game?", "Your place opens for someone else.", "Leave", true)) await run({ kind: "leave" });
      if (s === "manage") setManaging(true);
    };
    if (d.i_organize) {
      handlers.onDecide = (profileId, accept) => void run({ kind: "decide", profileId, accept });
      handlers.onRemove = async (profileId) => {
        if (await confirm("Remove this player?", "They are told, and they can't ask to join this game again.", "Remove", true)) await run({ kind: "remove", profileId });
      };
      handlers.onChoose = async (c) => {
        if (c === "link") setPicking(true);
        if (c === "without" && await confirm("Go ahead without a court booking?", "The game will show “No court booked through CourtBook”. Your players are told.", "Go ahead")) await run({ kind: "resolveCourt", bookingId: null });
        if (c === "cancel" && await confirm("Cancel this game?", "Everyone in the game and everyone waiting is told.", "Cancel game", true)) await run({ kind: "status", status: "cancelled" });
      };
    }
  }

  return page(
    <>
      <GameDetailView key={id} sections={screen.sections} me={me} pendingCount={d.i_organize ? d.pending ?? 0 : null} handlers={handlers}
                      refreshing={screen.refreshing} onRefresh={screen.refetch} />
      {SCREEN_FEATURES.writes && d.i_organize ? (
        <ManageSheet visible={managing} actions={organiserActions(d)} onClose={() => setManaging(false)}
                     onPick={async (k) => {
                       setManaging(false);
                       if (k === "make_private" && await confirm("Make this game private?", "It leaves Find a game, and waiting requests are declined.", "Make private")) await run({ kind: "status", status: "closed" });
                       if (k === "reopen") await run({ kind: "status", status: "open" });
                       if (k === "cancel" && await confirm("Cancel this game?", "Everyone in the game and everyone waiting is told.", "Cancel game", true)) await run({ kind: "status", status: "cancelled" });
                     }} />
      ) : null}
      {SCREEN_FEATURES.writes && d.i_organize ? (
        <BookingPicker visible={picking} sport={d.sport} onClose={() => setPicking(false)}
                       onPick={async (bookingId) => { setPicking(false); await run({ kind: "resolveCourt", bookingId }); }} />
      ) : null}
    </>,
  );
}

/** What the person is told after an action. "Done" needs no message: the refreshed game shows it. */
function report(o: ActionOutcome) {
  if (o.kind === "refused") Alert.alert("Not done", o.failure.message);
  if (o.kind === "uncertain") Alert.alert("Couldn't confirm", "The connection dropped. The game has been refreshed — check it before trying again.");
  if (o.kind === "signed-out") router.push("/sign-in");
}
