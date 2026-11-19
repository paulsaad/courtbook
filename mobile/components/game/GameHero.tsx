import { StyleSheet, View } from "react-native";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { CourtLines } from "../CourtLines";
import { SportMark } from "../SportMark";
import { sportName } from "../../lib/days";
import { NO_COURT } from "../../lib/gameFormat";
import { color, font, radius, space } from "../../lib/theme";
import type { DetailSection } from "../../lib/gameScreens";

/** Like the booking ticket: the time stays on one line and follows text size only this far (F7). */
export const HERO_TIME_MAX_SCALE = 1.2;

type Hero = Extract<DetailSection, { kind: "hero" }>;

/**
 * The game's night-green hero (approved Stitch exports 26–30): red top edge, Court Lines, the sport
 * and date, the time as a scoreboard, one status pill under the time (white on translucent white,
 * never red), then the club and the court. A game with no court booked through CourtBook says so in
 * those words (P1); after a cancelled booking the court line says the same, never a struck-out court.
 */
export function GameHero({ hero }: { hero: Hero }) {
  const place = [hero.club, hero.town].filter(Boolean).join(" · ");
  const a11y = [sportName(hero.sport), hero.when.a11y, hero.statusLabel, place, hero.courtText].filter(Boolean).join(", ");
  return (
    <View style={styles.card} accessible accessibilityLabel={a11y} testID="game-hero">
      <View style={styles.edge} />
      <CourtLines opacity={0.08} />
      <View style={styles.body}>
        <View style={styles.topRow}>
          <View style={styles.eyebrowRow}>
            <SportMark sport={hero.sport} size={16} color={color.redOnDark} />
            <Text style={styles.eyebrow}>{`${sportName(hero.sport)} · ${hero.dateLine}`}</Text>
          </View>
          <View style={styles.levels}><Text style={styles.levelsText}>{hero.levels ?? "All levels"}</Text></View>
        </View>
        <View style={styles.timeRow}>
          <Text style={styles.time} maxFontSizeMultiplier={HERO_TIME_MAX_SCALE} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {hero.when.time.replace("–", " – ")}
          </Text>
          {hero.minutes ? <Text style={styles.minutes}>{`${hero.minutes} min`}</Text> : null}
        </View>
        <View style={styles.status} testID="game-status"><Text style={styles.statusText}>{hero.statusLabel}</Text></View>
        <View style={styles.rule} />
        {place ? (
          <View style={styles.line}>
            <Icon name="pin" size={18} color={color.onDarkMuted} />
            <Text style={styles.club}>{place}</Text>
          </View>
        ) : null}
        <View style={styles.line} testID="game-court">
          <Icon name={hero.booked ? "check" : "court"} size={18} color={hero.booked ? "#7FD3A4" : color.onDarkMuted} strokeWidth={hero.booked ? 2.4 : 1.8} />
          <Text style={[styles.court, !hero.booked && styles.courtMuted]}>
            {hero.booked ? `${hero.courtText} · Booked through CourtBook` : NO_COURT}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.night, borderRadius: radius.lg, overflow: "hidden" },
  edge: { height: 4, backgroundColor: color.red },
  body: { padding: space.xl, gap: space.sm },
  topRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: space.sm, rowGap: space.xs },
  eyebrowRow: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  eyebrow: { flexShrink: 1, fontFamily: font.bold, fontSize: 13, lineHeight: 17, letterSpacing: 0.8, textTransform: "uppercase", color: color.redOnDark },
  levels: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.10)", borderWidth: 1, borderColor: "rgba(255,255,255,0.18)" },
  levelsText: { fontFamily: font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.6, textTransform: "uppercase", color: color.onDark },
  timeRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: space.md, marginTop: space.xs },
  time: { flex: 1, fontFamily: font.score, fontSize: 46, lineHeight: 52, color: color.onDark },
  minutes: { fontFamily: font.scoreSemi, fontSize: 18, lineHeight: 26, color: color.onDarkMuted, textTransform: "uppercase" },
  status: { alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: "rgba(255,255,255,0.14)", borderWidth: 1, borderColor: "rgba(255,255,255,0.22)" },
  statusText: { fontFamily: font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.6, textTransform: "uppercase", color: color.onDark },
  rule: { height: 1, backgroundColor: "rgba(255,255,255,0.14)", marginVertical: space.xs },
  line: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  club: { flex: 1, fontFamily: font.semibold, fontSize: 16, lineHeight: 22, color: color.onDark },
  court: { flex: 1, fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: color.onDark },
  courtMuted: { fontFamily: font.regular, color: color.onDarkMuted },
});
