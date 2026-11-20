import { Pressable, RefreshControl, ScrollView, StyleSheet, View, type ScrollViewInstance } from "react-native";
import { useRef } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { levelLabel } from "@shared/levels";
import { Text } from "../Text";
import { Icon, type IconName } from "../Icon";
import { Button } from "../Button";
import { GameHero } from "./GameHero";
import { GameBanner } from "./GameBanner";
import { GameSection } from "./GameSection";
import { FitPill } from "./FitPill";
import { SlotDots } from "./SlotDots";
import { color, font, radius, space, TOUCH } from "../../lib/theme";
import type { DetailSection, ResolveChoice } from "../../lib/gameScreens";
import type { Banner, Secondary } from "../../lib/gameState";
import type { ParticipantRow } from "../../lib/gameTypes";

type Of<K extends DetailSection["kind"]> = Extract<DetailSection, { kind: K }>;

/**
 * Handlers for what a person can do. Each is optional: when it is missing the control is not drawn,
 * so nothing that does not work is ever shown as a button (game writes stay off until M3-H).
 */
export type DetailHandlers = {
  onPrimary?: () => void;
  onSecondary?: (s: Secondary) => void;
  onDecide?: (profileId: string, accept: boolean) => void;
  onRemove?: (profileId: string) => void;
  onChoose?: (c: ResolveChoice["kind"]) => void;
  onOpenClub?: () => void;
  busy?: (key: string) => boolean;
};

const BANNER_TITLE: Partial<Record<Banner["kind"], string>> = {
  court_lost: "Court booking cancelled",
  pending: "Request sent",
  waiting: "On the waiting list",
};
const SECONDARY_LABEL: Record<Secondary, string> = { withdraw: "Withdraw request", leave: "Leave game", manage: "Manage game", hide: "Hide from my games", directions: "Directions" };

/**
 * One Game screen for every viewer and state (approved Stitch exports 26–30): banners, hero,
 * players, requests (organiser), organiser and note, details, the court-cancelled choices
 * (organiser), and the action bar. What appears comes from detailSections() — the role and state the
 * database returned — so the same components serve states A–E and playing, played, private, full and
 * cancelled. Names appear only when the database returned them (organiser and accepted players).
 */
export function GameDetailView({ sections, me, pendingCount, handlers = {}, refreshing = false, onRefresh }: {
  sections: DetailSection[]; me: string | null; pendingCount: number | null; handlers?: DetailHandlers;
  refreshing?: boolean; onRefresh?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollViewInstance | null>(null);
  const resolveY = useRef(0);
  const get = <K extends DetailSection["kind"]>(k: K) => sections.find((s) => s.kind === k) as Of<K> | undefined;
  const hero = get("hero")!;
  const banners = get("banners");
  const actions = get("actions")!;
  const players = get("players")!;
  const requests = get("requests");
  const details = get("details")!;
  const resolve = get("resolve");
  const organiserView = pendingCount != null;

  const primaryPress = actions.primary?.kind === "resolve_court"
    ? () => scroll.current?.scrollTo({ y: resolveY.current, animated: true })
    : handlers.onPrimary;

  return (
    <View style={styles.page} testID="game-detail">
      <ScrollView ref={scroll} contentContainerStyle={styles.content}
                  refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.cedar} /> : undefined}>
        {organiserView ? (
          <View style={styles.organiserStrip} testID="organiser-strip">
            <View style={styles.organiserDot} />
            <Text style={styles.organiserStripText}>You're the organiser</Text>
            {pendingCount ? <Text variant="secondary" style={{ color: color.cedarDeep }}>{pendingCount === 1 ? "1 request waiting" : `${pendingCount} requests waiting`}</Text> : null}
          </View>
        ) : null}
        {banners?.banners.map((b) => <GameBanner key={b.kind} tone={b.tone} title={BANNER_TITLE[b.kind]} text={b.text} testID={`banner-${b.kind}`} />)}

        <GameHero hero={hero} />

        {requests ? (
          <GameSection title={`Requests (${requests.rows.length})`} note={handlers.onDecide ? "Waiting for you" : null} testID="requests">
            {requests.rows.map((r) => (
              <View key={r.profile_id} style={styles.request}>
                <View style={styles.personText}>
                  <Text variant="strong">{r.name ?? "Player"}</Text>
                  <Text variant="secondary">{levelLabel(r.level)}</Text>
                </View>
                {handlers.onDecide ? (
                  <View style={styles.decide}>
                    <View style={{ flex: 1 }}><Button label="Decline" variant="secondary" busy={handlers.busy?.(`decide:${r.profile_id}`)} onPress={() => handlers.onDecide!(r.profile_id, false)} /></View>
                    <View style={{ flex: 1 }}><Button label="Accept" busy={handlers.busy?.(`decide:${r.profile_id}`)} onPress={() => handlers.onDecide!(r.profile_id, true)} /></View>
                  </View>
                ) : null}
              </View>
            ))}
          </GameSection>
        ) : null}

        <GameSection title="Players" note={`${players.spots.filled} of ${players.spots.capacity} places filled`} testID="players">
          <SlotDots filled={players.spots.filled} capacity={players.spots.capacity} size={22} paused={players.paused}
                    text={players.paused ? "Joining paused" : players.spots.text} />
          {players.names ? (
            <View style={styles.names} testID="player-names">
              {players.names.map((p) => <PlayerRow key={p.profile_id} p={p} me={me} onRemove={!p.is_organizer && handlers.onRemove ? () => handlers.onRemove!(p.profile_id) : undefined} />)}
            </View>
          ) : players.privacyNote ? (
            <View style={styles.privacy} testID="privacy-note">
              <Icon name="info" size={18} color={color.muted} />
              <Text variant="secondary" style={{ flex: 1 }}>{players.privacyNote}</Text>
            </View>
          ) : null}
        </GameSection>

        <GameSection title="Organiser">
          <View style={styles.person}>
            <Text variant="strong" style={{ flexShrink: 1 }}>{details.organiser ?? "The organiser"}</Text>
            <Tag text={organiserView ? "You" : "Host"} />
          </View>
          {details.note ? (
            <View style={styles.quote}><Text style={styles.quoteText}>{`“${details.note}”`}</Text></View>
          ) : null}
        </GameSection>

        <View style={styles.detailsCard} testID="details">
          <DetailRow label="Levels" value={details.level.replace(/^Levels /, "")} />
          <DetailRow label="How to join" value={details.joinMode} />
          <View style={[styles.detailRow, !handlers.onOpenClub && styles.lastRow]}>
            <Text variant="secondary">Your level</Text>
            <FitPill text={details.fit.text} tone={details.fit.tone} />
          </View>
          {handlers.onOpenClub ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Club info and directions" onPress={handlers.onOpenClub} style={[styles.detailRow, styles.lastRow, styles.link]}>
              <Text style={styles.linkText}>Club info and directions</Text>
              <Icon name="chevronRight" size={20} color={color.cedar} />
            </Pressable>
          ) : null}
        </View>

        {resolve ? (
          <View onLayout={(e) => { resolveY.current = e.nativeEvent.layout.y; }}>
            <GameSection title="What you can do" testID="resolve">
              <Text variant="body">
                {`The court booking${resolve.club ? ` at ${resolve.club}` : ""} was cancelled. Choose how the game goes on — your players are told. Nothing books a new court for you.`}
              </Text>
              {resolve.choices.map((c) => <ChoiceRow key={c.kind} c={c} onPress={resolve.enabled && handlers.onChoose ? () => handlers.onChoose!(c.kind) : undefined} />)}
            </GameSection>
          </View>
        ) : null}
      </ScrollView>

      <ActionBar actions={actions} spots={hero.phase === "open" && !organiserView && !players.names ? players.spots.text : null}
                 onPrimary={primaryPress} onSecondary={handlers.onSecondary} busy={handlers.busy} bottom={insets.bottom} />
    </View>
  );
}

function Tag({ text }: { text: string }) {
  return <View style={styles.tag}><Text style={styles.tagText}>{text}</Text></View>;
}

function PlayerRow({ p, me, onRemove }: { p: ParticipantRow; me: string | null; onRemove?: () => void }) {
  return (
    <View style={styles.nameRow}>
      <View style={styles.personText}>
        <View style={styles.person}>
          <Text variant="strong" style={{ flexShrink: 1 }}>{p.name ?? "Player"}</Text>
          {p.is_organizer ? <Tag text="Host" /> : null}
          {p.profile_id === me ? <Tag text="You" /> : null}
        </View>
        <Text variant="secondary">{levelLabel(p.level)}</Text>
      </View>
      {onRemove ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${p.name ?? "player"}`} onPress={onRemove} style={styles.remove}>
          <Text style={styles.removeText}>Remove</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text variant="secondary">{label}</Text>
      <Text variant="strong" style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const CHOICE_ICON: Record<ResolveChoice["kind"], IconName> = { link: "calendar", without: "court", cancel: "close" };

/** A court-cancelled choice. Without a handler it is information only — not drawn as a button. */
function ChoiceRow({ c, onPress }: { c: ResolveChoice; onPress?: () => void }) {
  const ink = c.kind === "cancel" ? color.danger : color.ink;
  const inner = (
    <>
      <Icon name={CHOICE_ICON[c.kind]} size={20} color={ink} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.choiceLabel, { color: ink }]}>{c.label}</Text>
        <Text variant="caption">{c.hint}</Text>
      </View>
      {onPress ? <Icon name="chevronRight" size={20} color={color.muted} /> : null}
    </>
  );
  return onPress
    ? <Pressable accessibilityRole="button" accessibilityLabel={c.label} accessibilityHint={c.hint} onPress={onPress} style={styles.choice}>{inner}</Pressable>
    : <View style={styles.choice} testID={`choice-${c.kind}`}>{inner}</View>;
}

/**
 * The fixed bar under the screen: one primary action, or — while that action is not available in the
 * app — the sentence that says so (never a greyed button pretending to work). Text actions below.
 */
/** The fixed bar stays a bar at the largest text sizes (it measured ~40% of a 360dp screen at ×2.0). */
const BAR_MAX_FONT_SCALE = 1.3;

function ActionBar({ actions, spots, onPrimary, onSecondary, busy, bottom }: {
  actions: Of<"actions">; spots: string | null; onPrimary?: () => void; onSecondary?: (s: Secondary) => void; busy?: (key: string) => boolean; bottom: number;
}) {
  const secondary = onSecondary ? actions.secondary.filter((s) => s !== "directions") : [];
  if (!actions.primary && !actions.notice && secondary.length === 0) return null;
  return (
    <View style={[styles.bar, { paddingBottom: bottom + space.md }]} testID="action-bar">
      <View style={styles.barRow}>
        {spots ? (
          <View style={styles.barSpots}>
            <Text maxFontSizeMultiplier={BAR_MAX_FONT_SCALE} numberOfLines={1} style={styles.barSpotsText}>{spots}</Text>
          </View>
        ) : null}
        {actions.primary && onPrimary ? (
          <View style={{ flex: 1, minWidth: 180 }}>
            <Button label={actions.primary.label} busy={busy?.(actions.primary.kind)} onPress={onPrimary} />
          </View>
        ) : actions.notice ? (
          <View style={styles.notice} testID="action-notice">
            <Icon name="info" size={18} color={color.muted} />
            <Text variant="secondary" maxFontSizeMultiplier={BAR_MAX_FONT_SCALE} style={{ flex: 1 }}>{actions.notice}</Text>
          </View>
        ) : null}
      </View>
      {secondary.length ? (
        <View style={styles.secondaryRow}>
          {secondary.map((s) => (
            <Pressable key={s} accessibilityRole="button" onPress={() => onSecondary!(s)} style={styles.secondary}>
              <Text style={styles.secondaryText}>{SECONDARY_LABEL[s]}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl },
  organiserStrip: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: color.cedarSoft, borderWidth: 1, borderColor: "#BFDFCB" },
  organiserDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.cedar },
  organiserStripText: { flex: 1, minWidth: 160, fontFamily: font.bold, fontSize: 14, letterSpacing: 0.6, textTransform: "uppercase", color: color.cedarDeep },
  request: { gap: space.md, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: "#EEEAE1" },
  decide: { flexDirection: "row", gap: space.sm },
  names: { gap: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: "#EEEAE1", minHeight: TOUCH },
  personText: { flex: 1, gap: 2 },
  person: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm },
  tag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: color.cedarSoft },
  tagText: { fontFamily: font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.5, textTransform: "uppercase", color: color.cedarDeep },
  remove: { minHeight: TOUCH, minWidth: TOUCH, justifyContent: "center", paddingHorizontal: space.sm },
  removeText: { fontFamily: font.semibold, fontSize: 15, color: color.danger },
  privacy: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: "#F7F4ED" },
  quote: { borderLeftWidth: 2, borderLeftColor: color.red, paddingLeft: space.md, paddingVertical: space.xs },
  quoteText: { fontFamily: font.regular, fontStyle: "italic", fontSize: 16, lineHeight: 22, color: color.ink },
  detailsCard: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, paddingHorizontal: space.lg },
  detailRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: space.md, rowGap: space.xs, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: "#EEEAE1", minHeight: TOUCH },
  lastRow: { borderBottomWidth: 0 },
  detailValue: { flexShrink: 1, textAlign: "right" },
  link: { justifyContent: "space-between" },
  linkText: { fontFamily: font.semibold, fontSize: 16, color: color.cedar },
  choice: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: "#F7F4ED", minHeight: TOUCH },
  choiceLabel: { fontFamily: font.semibold, fontSize: 16, lineHeight: 21 },
  bar: { backgroundColor: color.card, borderTopWidth: 1, borderTopColor: color.line, paddingHorizontal: space.lg, paddingTop: space.md, gap: space.xs },
  barRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md },
  barSpots: { flexShrink: 0 },
  barSpotsText: { fontFamily: font.score, fontSize: 22, lineHeight: 26, color: color.red, textTransform: "uppercase" },
  notice: { flex: 1, minWidth: 200, flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: space.sm },
  secondaryRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: space.lg },
  secondary: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.sm },
  secondaryText: { fontFamily: font.semibold, fontSize: 15, color: color.muted },
});
