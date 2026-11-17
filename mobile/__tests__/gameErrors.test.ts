import { COURT_PAUSED, GAME_ERRORS, gameFailure } from "../lib/gameErrors";

// Test plan U2 — every server reason the game screens can meet has one sentence; the KIND still
// comes from the M2 classifier, so retry and sign-in behaviour is unchanged.

const UX_CODES = [
  "not_found", "forbidden", "match_full", "match_closed", "match_started", "match_not_finished", "join_declined",
  "organizer_cannot_join", "not_pending", "cannot_reopen", "below_accepted", "bad_players_needed", "bad_level_range",
  "bad_level", "bad_join_mode", "bad_range", "note_too_long", "slot_in_past", "booking_not_found",
  "booking_already_posted", "sport_mismatch", "club_required", "too_far_ahead", "match_cancelled", "match_over",
  "court_lost", "court_not_lost", "blocked", "message_not_allowed", "rules_not_accepted", "slow_down",
  "too_many_games", "too_many_requests", "account_suspended",
];

describe("game copy map", () => {
  it("covers every code in the UX spec §4.8", () => {
    for (const c of UX_CODES) expect(GAME_ERRORS[c]).toBeTruthy();
  });
  it.each(UX_CODES)("%s is a refusal with its sentence", (code) => {
    expect(gameFailure({ message: code, code: "P0001" })).toEqual({ kind: "refused", message: GAME_ERRORS[code], reason: code });
  });
  it("says 'game', never 'match'", () => {
    for (const text of Object.values(GAME_ERRORS)) expect(text).not.toMatch(/\bmatch\b/i);
  });
});

describe("gameFailure", () => {
  it("not_found is the game sentence, not the web's payment sentence", () => {
    expect(gameFailure({ message: "not_found" }).message).toBe("This game isn't open any more, or isn't available to you.");
  });
  it("the longest reason wins (booking_not_found is not not_found)", () => {
    expect(gameFailure({ message: "booking_not_found" }).reason).toBe("booking_not_found");
  });
  it("finds a reason inside a longer database message", () => {
    expect(gameFailure({ message: 'ERROR:  match_full\nCONTEXT: PL/pgSQL function join_match(uuid)' }).reason).toBe("match_full");
  });
  it("match_closed on a game whose court was lost explains the pause (GR-9)", () => {
    expect(gameFailure({ message: "match_closed" }, { courtLost: true })).toEqual({ kind: "refused", message: COURT_PAUSED, reason: "match_closed" });
    expect(gameFailure({ message: "match_closed" }).message).toBe("This game is no longer open.");
  });

  it("auth failures stay auth (the app signs in again), whatever the text", () => {
    expect(gameFailure({ message: "JWT expired", code: "PGRST301" }).kind).toBe("auth");
    expect(gameFailure({ message: "not_authenticated" }).kind).toBe("auth");
    expect(gameFailure({ message: "unauthorized", status: 401 }).kind).toBe("auth");
  });
  it("offline / timeout stays network: the outcome is unknown, never a refusal", () => {
    expect(gameFailure(new TypeError("Network request failed")).kind).toBe("network");
    expect(gameFailure({ name: "AbortError", message: "The operation was aborted" }).kind).toBe("network");
    expect(gameFailure({ message: "The Internet connection appears to be offline." }).kind).toBe("network");
  });
  it("unknown server errors are 'unknown' with a retry sentence, not a guessed reason", () => {
    expect(gameFailure({ message: "duplicate key value violates unique constraint", code: "23505" })).toEqual({ kind: "unknown", message: "Something went wrong. Try again." });
    expect(gameFailure(undefined).kind).toBe("unknown");
    expect(gameFailure({ message: "matches_full_index broken" }).kind).toBe("unknown"); // not the word match_full
  });
  it("a web refusal the game map doesn't list keeps the web sentence", () => {
    expect(gameFailure({ message: "slot_taken" })).toMatchObject({ kind: "refused", reason: "slot_taken" });
  });
});
