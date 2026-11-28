import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Text } from "../../components/Text";
import { KeyboardAware } from "../../components/KeyboardAware";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { DateStrip } from "../../components/DateStrip";
import { Empty, ErrorState, Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { ChoiceRow, Field, JoinModeField, LevelRangeField, NoteField, Stepper } from "../../components/game/GameFields";
import { useSession } from "../../lib/session";
import { useOnline } from "../../lib/online";
import { bookingDays, sportName } from "../../lib/days";
import { durationLabel } from "../../lib/courts";
import { GAME_WRITES_AVAILABLE } from "../../lib/gameActions";
import {
  bookingLine, DURATIONS, initialDraft, POST_TOKEN_AVAILABLE, MAX_PLAYERS, missing, NOTE_MAX, POST_DAYS, postArgs, startTimes, usePostBookings, usePostClubs, usePostGame,
  type PostBooking, type PostClub, type PostDraft,
} from "../../lib/postGame";
import { newMessageId as newKey } from "../../lib/chat";
import { color, radius, space } from "../../lib/theme";
import { useSports } from "../../lib/sports";
import { NO_COURT } from "../../lib/gameFormat";

const playersUnit = (n: number) => (n === 1 ? "player needed" : "players needed");

/**
 * Post a game (docs/m3/03-journeys.md J6; 04-ux-spec.md §4.6). From Find a game ("Post a game") or
 * from one of the player's bookings ("Find players", `?booking=`). Every rule is the server's
 * (post_match): this screen collects the choices, shows its answer, and after a lost answer only
 * checks — it never posts twice (lib/postGame.ts).
 */
export default function PostGame() {
  const insets = useSafeAreaInsets();   // A17: the last controls must clear Android's navigation bar (edge to edge)
  const params = useLocalSearchParams<{ booking?: string; club?: string }>();
  const session = useSession();
  const signedIn = session.status === "signed-in";
  const online = useOnline();
  const clubs = usePostClubs(signedIn && GAME_WRITES_AVAILABLE);
  const bookings = usePostBookings(signedIn && GAME_WRITES_AVAILABLE);
  const [d, setD] = useState<PostDraft>(() => initialDraft(params.booking ?? null, params.club ?? null));
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<{ args: ReturnType<typeof postArgs>; since: Date } | null>(null);
  const [checking, setChecking] = useState(false);
  const { post, check, busy } = usePostGame();
  // one key for this visit (0073): every retry of the post sends it, so the server returns one game
  const key = useRef(newKey());
  const set = (p: Partial<PostDraft>) => { setD((x) => ({ ...x, ...p })); setProblem(null); };

  const usable = useMemo(() => (bookings.data ?? []).filter((b) => !b.gameId), [bookings.data]);
  const booking = d.bookingId ? (bookings.data ?? []).find((b) => b.id === d.bookingId) ?? null : null;
  // the clubs' sports that are active in the catalogue, by display name (#66 review SF3); the database refuses the rest
  const catalogue = useSports();
  const sports = useMemo(() => {
    const here = new Set((clubs.data ?? []).flatMap((c) => c.sports));
    return catalogue.filter((s) => here.has(s.code)).map((s) => s.code);
  }, [clubs.data, catalogue]);
  const clubsForSport = (clubs.data ?? []).filter((c) => !d.sport || c.sports.includes(d.sport));
  const club: PostClub | null = (clubs.data ?? []).find((c) => c.id === (booking?.clubId ?? d.clubId)) ?? null;
  const days = useMemo(() => (club ? bookingDays(club.timezone, POST_DAYS) : []), [club]);
  const times = club && d.date ? startTimes(club, d.date, d.minutes) : [];

  // sensible first choices: the only sport, a club preselected from a link, today
  useEffect(() => {
    if (!d.sport && sports.length === 1) set({ sport: sports[0] });
    if (club && !d.date && days.length) set({ date: days[0].key });
  }, [sports, club, days]); // eslint-disable-line react-hooks/exhaustive-deps
  // a time that no longer fits (another day, length or club) is cleared, never silently moved
  useEffect(() => { if (d.time && !times.includes(d.time)) set({ time: null }); }, [times.join(), d.time]); // eslint-disable-line react-hooks/exhaustive-deps

  if (session.status === "signed-out") {
    return <View style={styles.page}><Stack.Screen options={{ title: "Post a game" }} /><SignInPrompt title="Sign in to post a game" body="Games are posted by signed-in players." /></View>;
  }
  const page = (body: React.ReactNode) => <View style={styles.page}><Stack.Screen options={{ title: "Post a game" }} />{body}</View>;
  if (!GAME_WRITES_AVAILABLE) return page(<Empty title="Not in the app yet" body="Posting games from the app arrives in the next update." />);
  if (clubs.isPending || bookings.isPending) return page(<Loading label="Loading clubs and your bookings" />);
  if (clubs.error) return page(<ErrorState error={clubs.error} onRetry={() => void clubs.refetch()} />);

  const fromBooking = params.booking ? (bookings.data ?? []).find((b) => b.id === params.booking) : undefined;
  if (params.booking && fromBooking?.gameId) {
    return page(
      <View style={{ padding: space.lg, gap: space.md }}>
        <Empty title="You already posted a game for this booking" body={bookingLine(fromBooking)} />
        <Button label="Open your game" onPress={() => router.replace({ pathname: "/game/[id]", params: { id: fromBooking.gameId! } })} />
      </View>,
    );
  }

  const why = missing(d);
  const where = booking?.clubName ?? club?.name;
  const submit = async (retry = false) => {
    if (why || busy || (pending && !retry)) return;
    if (retry) setPending(null);
    const args = postArgs(d, club, booking, POST_TOKEN_AVAILABLE ? key.current : undefined);
    const out = await post(args);
    if (out.kind === "done") { router.replace({ pathname: "/game/[id]", params: { id: out.gameId } }); return; }
    if (out.kind === "existing") { router.replace({ pathname: "/game/[id]", params: { id: out.gameId } }); return; }
    if (out.kind === "signed-out") { router.push("/sign-in"); return; }
    if (out.kind === "uncertain") setPending({ args, since: out.since });
    setProblem(out.failure.message);
  };
  const checkAgain = async () => {
    if (!pending) return;
    setChecking(true);
    const out = await check(pending.args, pending.since);
    setChecking(false);
    if (out.kind === "done") { router.replace({ pathname: "/game/[id]", params: { id: out.gameId } }); return; }
    if (out.kind === "none") { setPending(null); setProblem("Your game wasn't posted. You can post it now."); return; }
    setProblem(out.failure.message);
  };

  return page(
    <KeyboardAware>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: space.xxxl * 2 + insets.bottom }]} keyboardShouldPersistTaps="handled" testID="post-game">
        {usable.length > 0 || booking ? (
          <Field label="Court" hint={booking ? "Club, sport and time come from your booking." : null}>
            <ChoiceRow title="No booking — choose a time" detail="Arrange the court yourself" selected={!d.bookingId}
                       onPress={() => set({ bookingId: null, playersNeeded: d.bookingId ? 3 : d.playersNeeded })} testID="booking-none" />
            {(booking && !usable.includes(booking) ? [booking, ...usable] : usable).map((b) => (
              <ChoiceRow key={b.id} title={`${sportName(b.sport)} · your booking`} detail={bookingLine(b)} selected={d.bookingId === b.id}
                         onPress={() => set({ bookingId: b.id, sport: b.sport, playersNeeded: d.bookingId ? d.playersNeeded : 1 })} testID={`booking-${b.id}`} />
            ))}
          </Field>
        ) : null}

        {!d.bookingId ? (
          <>
            {/* A17, 28 Nov: a game without a booking can be posted for any time, even when CourtBook shows no free
                court (allowed: players may arrange the court themselves). Never let it look like a reservation. */}
            <View style={styles.notice} testID="post-no-court">
              <Text variant="strong">{NO_COURT}</Text>
              <Text variant="secondary">Posting a game doesn't reserve a court. Book one in Courts first, or arrange it with the club yourself.</Text>
            </View>
            <Field label="Sport">
              <View style={styles.wrap}>
                {sports.map((s) => <Chip key={s} tone="sport" testID={`sport-${s}`} label={sportName(s)} selected={d.sport === s} onPress={() => set({ sport: s, clubId: clubs.data!.find((c) => c.id === d.clubId)?.sports.includes(s) ? d.clubId : null })} />)}
              </View>
            </Field>
            {d.sport ? (
              <Field label="Club">
                {clubsForSport.map((c) => (
                  <ChoiceRow key={c.id} title={c.name} detail={c.town} selected={d.clubId === c.id} onPress={() => set({ clubId: c.id })} testID={`club-${c.id}`} />
                ))}
              </Field>
            ) : null}
            {club ? (
              <>
                <Field label="Day">
                  <DateStrip days={days} selected={d.date ?? ""} onSelect={(k) => set({ date: k })} />
                </Field>
                <Field label="Length">
                  <View style={styles.wrap}>
                    {DURATIONS.map((m) => <Chip key={m} label={durationLabel(m)} selected={d.minutes === m} onPress={() => set({ minutes: m })} />)}
                  </View>
                </Field>
                <Field label="Start time" hint={times.length === 0 ? "No start times left on this day. Choose another day." : `Club time (${club.name}).`}>
                  <View style={styles.wrap}>
                    {times.map((t) => <Chip key={t} label={t} selected={d.time === t} onPress={() => set({ time: t })} testID={`start-${t}`} />)}
                  </View>
                </Field>
              </>
            ) : null}
          </>
        ) : null}

        <Field label="Players needed" hint="Not counting you.">
          <Stepper value={d.playersNeeded} min={1} max={MAX_PLAYERS} onChange={(n) => set({ playersNeeded: n })} label="Players needed" unit={playersUnit} testID="players" />
        </Field>
        <LevelRangeField min={d.levelMin} max={d.levelMax} onChange={(levelMin, levelMax) => set({ levelMin, levelMax })} />
        <JoinModeField value={d.joinMode} onChange={(joinMode) => set({ joinMode })} />
        <NoteField value={d.note} onChange={(note) => set({ note })} max={NOTE_MAX} />

        <View style={styles.footer}>
          {where && !why ? (
            <Text variant="secondary" testID="post-review">
              Your game will appear on Find a game for players at {where}.{d.bookingId ? " Your court booking is linked to it." : ` It will show “${NO_COURT}”.`}
            </Text>
          ) : null}
          {problem ? <Text style={styles.problem} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="post-problem">{problem}</Text> : null}
          {pending && POST_TOKEN_AVAILABLE ? (
            // with the key a retry cannot make a second game: posting again is the check
            <Button label="Try again" busy={busy} disabled={!online} onPress={() => void submit(true)} testID="post-retry" />
          ) : pending ? (
            <Button label="Check again" variant="secondary" busy={checking} onPress={() => void checkAgain()} testID="post-check" />
          ) : (
            <Button label="Post game" busy={busy} disabled={!!why || !online} onPress={() => void submit()} testID="post-submit" />
          )}
          {!pending && (why || !online) ? <Text variant="secondary">{!online ? "You're offline. Connect to post a game." : why}</Text> : null}
        </View>
      </ScrollView>
    </KeyboardAware>,
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.lg, gap: space.xl, paddingBottom: space.xxxl * 2 },
  notice: { gap: space.xs, padding: space.md, borderRadius: radius.lg, backgroundColor: color.card, borderWidth: 1, borderColor: color.line },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  footer: { gap: space.md, paddingTop: space.sm },
  problem: { color: color.danger },
});
