import { friendlyError } from "@/lib/types";

/**
 * One sentence for a failed player action (join, leave, post a game, open a booking to players, save a level).
 *
 * A phone with no connection (fetch fails: Chrome "Failed to fetch", Safari "Load failed", Firefox
 * "NetworkError") used to get the shared fallback "Something went wrong. Refresh and try again." — and a
 * refresh with no connection replaces the page with the browser's offline page. It now says what happened;
 * everything else is the shared wording, unchanged.
 */
export const ACTION_OFFLINE = "Couldn't reach CourtBook. Check your connection and try again.";

export const isNetworkFailure = (message: string | undefined) => /failed to fetch|load failed|networkerror|network request failed/i.test(message ?? "");

export function actionError(message: string | undefined): string {
  return isNetworkFailure(message) ? ACTION_OFFLINE : friendlyError(message);
}
