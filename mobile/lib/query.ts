import { AppState, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { focusManager, MutationCache, onlineManager, QueryCache, QueryClient } from "@tanstack/react-query";
import { classify } from "./errors";
import { recoverFromAuthFailure } from "./authRecovery";

/**
 * Retry policy for reads. Writes are never retried automatically: a booking retry must carry its
 * idempotency token and re-read the database (M2), and that is the screen's job, not a library's.
 */
export function shouldRetryRead(failureCount: number, error: unknown): boolean {
  const kind = classify(error).kind;
  if (kind === "auth" || kind === "refused") return false;
  return failureCount < 2;
}

function onFailure(error: unknown) {
  if (classify(error).kind === "auth") void recoverFromAuthFailure();
}

export function makeQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onFailure }),
    mutationCache: new MutationCache({ onError: onFailure }),
    defaultOptions: {
      queries: {
        retry: shouldRetryRead,
        retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
        // Availability goes stale quickly; anything older than this is refetched when the screen
        // is shown again, when the app returns to the foreground, or when the connection returns.
        staleTime: 30_000,
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

let wired = false;

/** Tell React Query when the app is in the foreground and when the phone is online. */
export function wireAppLifecycle() {
  if (wired) return;
  wired = true;

  // "Window focus" on a phone is the app coming back to the foreground.
  AppState.addEventListener("change", (status) => {
    if (Platform.OS !== "web") focusManager.setFocused(status === "active");
  });

  // Queries pause while offline and resume (and refetch) when the connection returns.
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    })
  );
}
