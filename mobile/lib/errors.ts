import { ERRORS } from "@shared/types";

/**
 * One place that turns any failure into (a) what kind of failure it is and (b) one plain sentence.
 *
 * The sentences for database reasons are the web app's own table (src/lib/types.ts), imported in
 * place, so the phone and the website always say the same thing for the same refusal.
 *
 * The kind matters more than the words:
 *  - "network": the request may or may not have reached the server. Never conclude it failed;
 *    the caller re-reads the truth from the database (see M2 booking retries).
 *  - "auth": the session is gone or rejected. The app signs out locally and asks to sign in again.
 *  - "refused": the database said no, for a named reason. Retrying will not help.
 *  - "unknown": anything else. Shown with a retry.
 */
export type FailureKind = "network" | "auth" | "refused" | "unknown";
export type Failure = { kind: FailureKind; message: string; reason?: string };

type ErrorLike = { message?: unknown; code?: unknown; status?: unknown; name?: unknown };

const AUTH_CODES = new Set(["PGRST301", "PGRST302", "401", "session_not_found", "refresh_token_not_found", "bad_jwt"]);
const NETWORK_PATTERNS = [
  /network request failed/i, /failed to fetch/i, /network error/i, /timed? ?out/i, /aborted/i, /load failed/i,
  // iOS's own wording when the request never got an answer (airplane mode, dropped Wi-Fi)
  /internet connection/i, /offline/i, /network connection was lost/i, /could not connect/i, /not connected/i,
];
/** supabase-js reports a fetch that threw as "<ErrorName>: <text>" with an empty code — no server answered. */
const FETCH_FAILURE = /^(TypeError|FetchError|Error|AbortError|TimeoutError|NetworkError)\b/;

/** Database reasons named in ERRORS, longest first so `court_not_found` wins over `not_found`. */
const REASONS = Object.keys(ERRORS).sort((a, b) => b.length - a.length);

/** Reasons that are about the session rather than the request. */
const AUTH_REASONS = new Set(["not_authenticated"]);

export function classify(error: unknown): Failure {
  const e = (error ?? {}) as ErrorLike;
  const message = typeof e.message === "string" ? e.message : String(error ?? "");
  const code = e.code === undefined || e.code === null ? "" : String(e.code);
  const status = typeof e.status === "number" ? e.status : undefined;

  if (AUTH_REASONS.has(message.trim()) || AUTH_CODES.has(code) || status === 401 || /jwt expired/i.test(message)) {
    return { kind: "auth", message: "Your session has ended. Sign in again to continue." };
  }

  const noServerAnswer = code === "" && status === undefined && FETCH_FAILURE.test(message) && !REASONS.some((r) => message.includes(r));
  if (NETWORK_PATTERNS.some((p) => p.test(message)) || e.name === "AbortError" || noServerAnswer) {
    return { kind: "network", message: "No connection. Check your internet and try again." };
  }

  const reason = REASONS.find((r) => message.includes(r));
  if (reason) return { kind: "refused", message: ERRORS[reason], reason };

  return { kind: "unknown", message: "Something went wrong. Try again." };
}
