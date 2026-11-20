import { useMemo } from "react";
import { Redirect, useLocalSearchParams } from "expo-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { useSession } from "../lib/session";
import { E2E_SCREENS, e2eClient } from "../lib/e2eGames";
import FindAGame from "./games/index";
import GameScreen from "./game/[id]";

/**
 * EMULATOR TEST BUILD ONLY: the real Find a game and Game screens over the Stitch sample data, for
 * screenshots (courtbook-staging://e2e-games?view=board, …?view=detail&state=A&id=e2e-g). A release
 * build has no EXPO_PUBLIC_E2E and is sent to Home. The sample answers live in this screen's own
 * query client, so nothing here reaches the app's cache or the database.
 */
export default function E2EGames() {
  const { view = "board", state = "A" } = useLocalSearchParams<{ view?: string; state?: string }>();
  const session = useSession();
  const me = session.status === "signed-in" ? session.session.user.id : "e2e-me";
  const qc = useMemo(() => e2eClient(view, state, me), [view, state, me]);
  if (!E2E_SCREENS) return <Redirect href="/" />;
  return <QueryClientProvider client={qc}>{view === "board" ? <FindAGame /> : <GameScreen />}</QueryClientProvider>;
}
