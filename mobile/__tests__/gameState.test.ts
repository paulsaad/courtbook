import { gameView, NOT_AVAILABLE, organiserActions, phaseOf, roleOf, type Phase, type Role } from "../lib/gameState";
import { NO_COURT } from "../lib/gameFormat";
import type { GameDetail } from "../lib/gameTypes";

// Test plan U1 — presentation of every GR-1 state for every viewer role.
// These tests check WHAT IS SHOWN for a row the server returned. They are not permission tests:
// visibility is match_detail's (supabase/tests/m3/match_detail_0067.sh) and every action is
// re-checked by its database function.

const base: GameDetail = {
  match_id: "m1", club_id: "c1", club_name: "Batroun Padel & Tennis", club_slug: "batroun", club_timezone: "Asia/Beirut", town: "Batroun",
  sport: "padel", start_at: "2026-11-21T16:00:00Z", end_at: "2026-11-21T17:30:00Z",
  level_min: 4, level_max: 6, level_legacy: false, my_level: 5, players_needed: 3, joined: 1, pending: null,
  status: "open", closed_reason: null, court_lost: false, note: null, join_mode: "open",
  organizer_id: null, organizer_name: "Rami", my_status: null, i_organize: false,
  has_court: true, booking_id: null, court_name: "Court 2", started: false, finished: false, hidden: false,
};
const g = (over: Partial<GameDetail>): GameDetail => ({ ...base, ...over });

const STATES: Record<Phase, Partial<GameDetail>> = {
  open: {},
  full: { status: "closed", closed_reason: "full", joined: 3 },
  private: { status: "closed", closed_reason: "organizer" },
  court_lost: { status: "closed", closed_reason: "no_court", court_lost: true, has_court: false, court_name: null },
  playing: { started: true },
  played: { started: true, finished: true },
  cancelled: { status: "cancelled" },
};
const ROLES: Record<Exclude<Role, "waiting">, Partial<GameDetail>> = {
  organiser: { i_organize: true, my_status: null, organizer_id: "o", pending: 1 },
  accepted: { my_status: "accepted", organizer_id: "o" },
  pending: { my_status: "pending" },
  declined: { my_status: "declined" },
  outsider: {},
};

describe("phaseOf (GR-1)", () => {
  it.each(Object.entries(STATES))("%s", (phase, over) => {
    expect(phaseOf(g(over))).toBe(phase);
  });
  it("cancelled wins over time; time wins over court and closed reasons", () => {
    expect(phaseOf(g({ status: "cancelled", started: true, finished: true }))).toBe("cancelled");
    expect(phaseOf(g({ ...STATES.court_lost, started: true }))).toBe("playing");
    expect(phaseOf(g({ ...STATES.full, finished: true, started: true }))).toBe("played");
  });
  it("a private game whose court was lost shows the court problem first", () => {
    expect(phaseOf(g({ status: "closed", closed_reason: "organizer", court_lost: true }))).toBe("court_lost");
  });
});

describe("roleOf", () => {
  it("pending on a full game is the waiting list (GR-4); elsewhere it is a request", () => {
    expect(roleOf(g({ my_status: "pending" }), "full")).toBe("waiting");
    expect(roleOf(g({ my_status: "pending" }), "open")).toBe("pending");
    expect(roleOf(g({ my_status: "pending" }), "court_lost")).toBe("pending");
  });
  it("organiser beats any player row", () => {
    expect(roleOf(g({ i_organize: true, my_status: "accepted" }), "open")).toBe("organiser");
  });
});

describe("gameView — every state × every role", () => {
  const cases: [Phase, keyof typeof ROLES][] = [];
  for (const p of Object.keys(STATES) as Phase[]) for (const r of Object.keys(ROLES) as (keyof typeof ROLES)[]) cases.push([p, r]);

  it.each(cases)("%s as %s: consistent label, buttons and banners", (phase, role) => {
    const v = gameView(g({ ...STATES[phase], ...ROLES[role] }));
    expect(v.phase).toBe(phase);
    expect(v.statusLabel).toBeTruthy();
    const before = !["playing", "played", "cancelled"].includes(phase);
    const member = role === "organiser" || role === "accepted";

    // Join / Ask only for an outsider on an open game
    const joins = v.primary?.kind === "join" || v.primary?.kind === "ask";
    expect(joins).toBe(role === "outsider" && phase === "open");
    // Members always have the chat (read-only states are the chat screen's business)
    if (member && !(role === "organiser" && phase === "court_lost")) expect(v.primary?.kind).toBe("chat");
    // Names only for members (match_participants' own rule)
    expect(v.showsNames).toBe(member);
    // Leave / withdraw only before the game
    expect(v.secondary.includes("leave")).toBe(role === "accepted" && before);
    expect(v.secondary.includes("withdraw")).toBe((role === "pending") && before);
    // Manage until the game is over or cancelled
    expect(v.secondary.includes("manage")).toBe(role === "organiser" && phase !== "played" && phase !== "cancelled");
    // Hide once it is over or cancelled, members only
    expect(v.secondary.includes("hide")).toBe(member && (phase === "played" || phase === "cancelled"));
    // The court warning appears whenever the court was lost before play
    expect(v.banners.some((b) => b.kind === "court_lost")).toBe(phase === "court_lost");
  });
});

describe("gameView — wording from the approved journeys (J2)", () => {
  it("pending", () => {
    expect(gameView(g({ my_status: "pending" })).banners).toEqual([{ kind: "pending", tone: "warn", text: "Request sent — Rami will accept or decline." }]);
  });
  it("waiting list on a full game, with Withdraw", () => {
    const v = gameView(g({ ...STATES.full, my_status: "pending" }));
    expect(v.role).toBe("waiting");
    expect(v.banners[0].text).toBe("The game is full. You're on the waiting list — Rami can still add you if a place opens.");
    expect(v.secondary).toContain("withdraw");
  });
  it("accepted / declined", () => {
    expect(gameView(g({ my_status: "accepted" })).banners[0]).toEqual({ kind: "accepted", tone: "ok", text: "You're in." });
    expect(gameView(g({ my_status: "declined" })).banners[0].text).toBe("Rami didn't accept you for this game.");
    expect(gameView(g({ my_status: "declined" })).primary).toBeNull();
  });
  it("court booking cancelled: warning first, organiser gets 'Choose what to do', joiners get nothing to press", () => {
    const org = gameView(g({ ...STATES.court_lost, ...ROLES.organiser }));
    expect(org.banners[0]).toEqual({ kind: "court_lost", tone: "warn", text: "The court booking for this game was cancelled. Joining is paused until Rami decides." });
    expect(org.primary).toEqual({ kind: "resolve_court", label: "Choose what to do" });
    expect(org.statusLabel).toBe("Court cancelled");
    expect(gameView(g({ ...STATES.court_lost, my_status: "pending" })).banners.map((b) => b.kind)).toEqual(["court_lost", "pending"]);
    expect(gameView(g({ ...STATES.court_lost })).primary).toBeNull();
  });
  it("no organiser name falls back to 'the organiser'", () => {
    expect(gameView(g({ ...STATES.court_lost, organizer_name: null })).banners[0].text).toBe(
      "The court booking for this game was cancelled. Joining is paused until the organiser decides."
    );
    expect(gameView(g({ my_status: "pending", organizer_name: " " })).banners[0].text).toBe("Request sent — The organiser will accept or decline.");
  });
  it("approval games ask; open games join", () => {
    expect(gameView(g({ join_mode: "approval" })).primary).toEqual({ kind: "ask", label: "Ask to join" });
    expect(gameView(g({})).primary).toEqual({ kind: "join", label: "Join" });
  });
});

describe("gameView — join confirmations", () => {
  it("P1: a game with no CourtBook court always asks first, in plain words", () => {
    const v = gameView(g({ has_court: false, court_name: null }));
    expect(v.courtText).toBe(NO_COURT);
    expect(v.joinConfirm).toEqual(["No court is booked through CourtBook for this game. Rami says they are arranging the court. Join anyway?"]);
  });
  it("level outside the range asks first; inside, or level unset, does not", () => {
    expect(gameView(g({ my_level: 8, join_mode: "approval" })).joinConfirm).toEqual(["This game is for levels 4–6. You're 8. Ask to join anyway?"]);
    expect(gameView(g({ my_level: 5 })).joinConfirm).toEqual([]);
    expect(gameView(g({ my_level: null })).joinConfirm).toEqual([]);
    expect(gameView(g({ level_min: null, level_max: null, my_level: 9 })).joinConfirm).toEqual([]);
  });
  it("both reasons, in order", () => {
    expect(gameView(g({ has_court: false, my_level: 2 })).joinConfirm).toHaveLength(2);
  });
  it("nothing to confirm when there is no join button", () => {
    expect(gameView(g({ has_court: false, my_status: "accepted" })).joinConfirm).toEqual([]);
  });
});

describe("organiserActions (GR-8) — shown, never decided, here", () => {
  const org = (over: Partial<GameDetail>) => organiserActions(g({ ...ROLES.organiser, ...over }));
  const find = (a: ReturnType<typeof organiserActions>, k: string) => a.find((x) => x.kind === k);

  it("open game before start: everything enabled except removing nobody", () => {
    const a = org({ joined: 0 });
    expect(a.map((x) => x.kind)).toEqual(["edit", "make_private", "remove_player", "cancel"]);
    expect(find(a, "remove_player")).toEqual({ kind: "remove_player", enabled: false, reason: "No players have joined yet." });
    expect(find(a, "edit")?.enabled).toBe(true);
  });
  it("private game offers reopen instead of make private", () => {
    expect(org(STATES.private).map((x) => x.kind)).toContain("reopen");
  });
  it("court lost: resolve first; private/reopen disabled with the reason", () => {
    const a = org(STATES.court_lost);
    expect(a[0]).toEqual({ kind: "resolve_court", enabled: true, reason: null });
    expect(find(a, "make_private")).toEqual({ kind: "make_private", enabled: false, reason: "Sort out the court first." });
    expect(find(a, "cancel")?.enabled).toBe(true);
  });
  it("playing: only cancel stays enabled", () => {
    const a = org(STATES.playing);
    expect(a.filter((x) => x.enabled).map((x) => x.kind)).toEqual(["cancel"]);
    expect(find(a, "edit")?.reason).toBe("This game has already started.");
  });
  it("played and cancelled: nothing enabled", () => {
    expect(org(STATES.played).filter((x) => x.enabled)).toEqual([]);
    expect(find(org(STATES.played), "cancel")?.reason).toBe("This game has already been played.");
    expect(org(STATES.cancelled).filter((x) => x.enabled)).toEqual([]);
  });
});

describe("not visible", () => {
  it("one sentence that neither explains nor confirms the game exists (GR-2)", () => {
    expect(NOT_AVAILABLE).toBe("This game isn't open any more, or isn't available to you.");
  });
});
