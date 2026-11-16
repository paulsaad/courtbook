import { useState, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { feeSummary } from "@shared/fees";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { SportMark } from "./SportMark";
import { Empty, ErrorState, Loading } from "./StateView";
import {
  clubPhotos, clubSports, courtDetail, facilityGroups, infoDuration, lengthRange, mapsUrl, notAvailableSentence,
  rateCards, ratesNote, type ClubInfo,
} from "../lib/clubInfo";
import { sportName } from "../lib/days";
import { color, font, radius, space } from "../lib/theme";
import { haptic } from "../lib/haptics";
import { fade } from "../lib/motion";

/**
 * The club's Info tab, built to the approved design "CourtBook — Club Info (Definitive Master)"
 * (mobile/design/club-info/). Every value comes from the club's own data; the handoff's example
 * values are only the demo club's at the time of the review. A section the club has not filled in
 * is left out. Additions agreed with Paul on 2026-11-16, for data the design did not show: the
 * club's photos (below the quick stats), About as its own section, arrival notes in the Location card.
 */
export function ClubInfoView({ query, onBook }: {
  query: { data?: ClubInfo; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  onBook: () => void;
}) {
  const { width, fontScale } = useWindowDimensions();
  if (query.isPending) return <Loading label="Loading club details" />;
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Empty title="Club not found" body="It may no longer take bookings." />;

  // Handoff §5: below 340 pt the margins tighten, the hero buttons and rate cards stack, and the
  // quick-stat figures step down. Large text stacks the booking rules (label above value).
  const narrow = width < 340;
  const stackRules = narrow || fontScale >= 1.3;
  // At large text three columns can't hold "Free cancellation" without cutting it: one row per stat.
  const stackStats = fontScale >= 1.3;
  // Two buttons side by side only fit their labels at normal text sizes ("Directio-ns" otherwise).
  const stackActions = narrow || fontScale >= 1.3;

  const { club, courts, rules, gallery } = query.data;
  const sports = clubSports(courts);
  const maps = mapsUrl(club);
  const photos = clubPhotos(club.cover_url, gallery, club.name);
  const { has, hasNot } = facilityGroups(club);
  const notAvailable = notAvailableSentence(hasNot);
  const fees = feeSummary(club.payment_mode, club.service_fee_usd);
  const cards = rateCards(rules, courts);
  const place = [club.address, club.town?.name_en].filter(Boolean);

  const openMaps = () => { if (maps) { haptic.select(); void Linking.openURL(maps); } };

  return (
    <View style={[styles.wrap, narrow && { paddingHorizontal: space.md }]}>
      {/* Hero: night green with the Lebanese red crown along its top edge. */}
      <View style={styles.hero}>
        {sports.length > 0 && (
          <View style={styles.pills}>
            {sports.map((s) => (
              <View key={s} style={styles.pill}><Text style={styles.pillText}>{sportName(s)}</Text></View>
            ))}
          </View>
        )}
        {club.is_demo && (
          <View style={styles.demo}>
            <Icon name="info" size={14} color={color.warnInk} strokeWidth={2} />
            <Text style={styles.demoText}>Demo club — not a real venue</Text>
          </View>
        )}
        <Text style={styles.heroName} accessibilityRole="header">{club.name}</Text>
        {place.length > 0 && (
          <View style={styles.placeRow}>
            <Icon name="pin" size={16} color="rgba(255,255,255,0.8)" />
            <Text style={styles.placeText}>{place.join(" · ")}</Text>
          </View>
        )}
        <View style={[styles.actions, stackActions && styles.actionsStacked]}>
          <Pressable accessibilityRole="button" onPress={onBook} style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.pressed]}>
            <Icon name="calendar" size={18} color={color.night} strokeWidth={2} />
            <Text style={styles.btnPrimaryText} numberOfLines={2}>See free times</Text>
          </Pressable>
          {maps && (
            <Pressable accessibilityRole="link" accessibilityHint="Opens the map" onPress={openMaps} style={({ pressed }) => [styles.btn, styles.btnSecondary, pressed && styles.pressed]}>
              <Icon name="compass" size={18} color={color.onDark} strokeWidth={2} />
              <Text style={styles.btnSecondaryText} numberOfLines={2}>Directions</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Quick stats: the three numbers players ask about first. */}
      <View style={[styles.stats, stackStats && styles.statsStacked]}>
        <Stat value={`${club.open_time.slice(0, 5)}–${club.close_time.slice(0, 5)}`} label="Open daily" narrow={narrow} stacked={stackStats} wide />
        <View style={stackStats ? styles.statRuleH : styles.statRule} />
        <Stat value={lengthRange(club.min_booking_minutes, club.max_booking_minutes)} label="Play window" narrow={narrow} stacked={stackStats} />
        <View style={stackStats ? styles.statRuleH : styles.statRule} />
        <Stat value={`${club.cancel_cutoff_hours} h before`} label="Free cancellation" narrow={narrow} stacked={stackStats} />
      </View>

      {photos.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gallery} accessibilityLabel="Photos">
          {photos.map((ph) => (
            <View key={ph.key} style={styles.photo}>
              <Image source={{ uri: ph.uri }} style={styles.photoImg} contentFit="cover" transition={fade(200)} accessibilityLabel={ph.label} />
              {ph.caption && <Text variant="caption" numberOfLines={1} style={styles.photoCaption}>{ph.caption}</Text>}
            </View>
          ))}
        </ScrollView>
      )}

      <Section title="Hourly rates">
        <Text style={styles.ratesNote}>{ratesNote(club.is_demo)}</Text>
        {cards.length === 0 ? (
          <View style={styles.card}><Text variant="secondary">Prices are shown when you pick a time.</Text></View>
        ) : (
          <View style={styles.rateGrid}>
            {cards.map((r) => (
              <View key={r.key} style={[styles.card, styles.rateCard, narrow && styles.rateCardFull]}
                accessible accessibilityLabel={[r.title, r.period, r.court, `${r.price} per hour`].filter(Boolean).join(", ")}>
                <Text style={styles.rateTitle}>{r.title}</Text>
                {r.period && <Text style={styles.ratePeriod}>{r.period}</Text>}
                {r.court && <Text style={styles.rateCourt}>{r.court}</Text>}
                <View style={styles.rateLine}>
                  <Text style={styles.ratePrice}>{r.price}</Text>
                  <Text style={styles.rateUnit}>/ hr</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </Section>

      {(place.length > 0 || club.arrival_notes) && (
        <Section title="Location">
          <View style={styles.card}>
            {place.length > 0 && (
              <View style={styles.locationRow}>
                <View style={styles.locationIcon}><Icon name="pin" size={18} color={color.cedarDeep} strokeWidth={2} /></View>
                <Text style={styles.locationText}>{place.join(", ")}</Text>
              </View>
            )}
            {club.arrival_notes && <Text style={[styles.body, place.length > 0 && { marginTop: space.md }]}>{club.arrival_notes}</Text>}
          </View>
        </Section>
      )}

      {club.description && (
        <Section title="About">
          <View style={styles.card}><Text style={styles.body}>{club.description}</Text></View>
        </Section>
      )}

      {(has.length > 0 || notAvailable) && (
        <Section title="Facilities">
          <View style={styles.card}>
            {has.length > 0 && (
              <View style={styles.chips}>
                {has.map((label) => (
                  <View key={label} style={styles.chip}>
                    <Icon name="check" size={15} color={color.cedarDeep} strokeWidth={2.4} />
                    <Text style={styles.chipText}>{label}</Text>
                  </View>
                ))}
              </View>
            )}
            {notAvailable && (
              <View style={[styles.notAvailable, has.length > 0 && { marginTop: space.md }]}>
                <Text style={styles.notAvailableText}>• {notAvailable}</Text>
              </View>
            )}
          </View>
        </Section>
      )}

      {courts.length > 0 && (
        <Section title="Courts & surfaces" aside={`${courts.length} ${courts.length === 1 ? "court" : "courts"}`}>
          <View style={[styles.card, styles.courtsCard]}>
            {courts.map((c, i) => (
              <View key={c.id} style={styles.courtRow} accessible accessibilityLabel={`${c.name}, ${courtDetail(c)}`}>
                <View style={styles.courtMark}><SportMark sport={c.sport} size={22} /></View>
                <View style={[styles.courtText, i > 0 && styles.courtDivider]}>
                  <Text style={styles.courtName}>{c.name}</Text>
                  <Text style={styles.courtDetail}>{courtDetail(c)}</Text>
                </View>
              </View>
            ))}
          </View>
        </Section>
      )}

      <Section title="Booking rules">
        <View style={[styles.card, styles.rulesCard]} key={`${width}-${fontScale}`}>
          <Rule stacked={stackRules} label="Book ahead" value={`Up to ${club.booking_window_days} days`} />
          <Rule stacked={stackRules} label="Booking length" value={`${infoDuration(club.min_booking_minutes)} to ${infoDuration(club.max_booking_minutes)}, ${club.slot_minutes}-min steps`} />
          <Rule stacked={stackRules} label="Free cancellation" value={`Until ${club.cancel_cutoff_hours} h before; no refund after`} />
          <Rule stacked={stackRules} label="Booking fee" value={fees.fee} />
          {fees.payment && <Rule stacked={stackRules} strong label="Payment" value={fees.payment} />}
        </View>
      </Section>
    </View>
  );
}

/** `wide`: the opening hours ("08:00–23:00") get a little more room, so they never shrink or cut off. */
function Stat({ value, label, narrow, stacked, wide = false }: { value: string; label: string; narrow: boolean; stacked: boolean; wide?: boolean }) {
  if (stacked) {
    return (
      <View style={styles.statRow} accessible accessibilityLabel={`${label}: ${value}`}>
        <Text style={styles.statValue}>{value}</Text>
        <Text style={[styles.statLabel, { textAlign: "left", flexShrink: 1 }]}>{label}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.stat, wide && { flex: 1.3 }]} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={[styles.statValue, narrow && styles.statValueNarrow]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{value}</Text>
      <Text style={styles.statLabel} numberOfLines={2}>{label}</Text>
    </View>
  );
}

function Section({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.eyebrow} accessibilityRole="header">{title}</Text>
        {aside && <Text style={styles.sectionAside}>{aside}</Text>}
      </View>
      {children}
    </View>
  );
}

/** Values longer than this read better under their label than squeezed into the right-hand column. */
export const RULE_SIDE_MAX_CHARS = 26;

/**
 * A booking rule. Short values ("Up to 14 days", "None") sit beside the label, right-aligned. A long
 * value ("Until 6 h before; no refund after", the payment sentence), or any value that would wrap
 * beside its label on this screen and text size, goes under the label, left-aligned, wrapping
 * naturally. Large text or a narrow screen stacks every rule.
 */
function Rule({ label, value, stacked, strong = false }: { label: string; value: string; stacked: boolean; strong?: boolean }) {
  const [wraps, setWraps] = useState(false);
  const under = stacked || wraps || value.length > RULE_SIDE_MAX_CHARS;
  return (
    <View style={under ? styles.ruleStacked : styles.rule} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.ruleLabel}>{label}</Text>
      <Text
        style={[styles.ruleValue, strong && styles.ruleValueStrong, !under && styles.ruleValueSide]}
        onTextLayout={under ? undefined : (e) => { if (e.nativeEvent.lines.length > 1) setWraps(true); }}
      >{value}</Text>
    </View>
  );
}

const HAIRLINE = 1;

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.xl },

  // Hero (§4B)
  hero: { backgroundColor: color.night, borderRadius: 20, overflow: "hidden", borderTopWidth: 3.5, borderTopColor: color.red, padding: space.xl, gap: space.md },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  pill: { backgroundColor: "rgba(255,255,255,0.12)", borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontFamily: font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.8, textTransform: "uppercase", color: color.onDark },
  demo: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", backgroundColor: color.warnSoft, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  demoText: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: color.warnInk },
  heroName: { fontFamily: font.displayHeavy, fontSize: 26, lineHeight: 32, color: color.onDark },
  placeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: -4 },
  placeText: { fontFamily: font.regular, fontSize: 14, lineHeight: 19, color: "rgba(255,255,255,0.8)", flexShrink: 1 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.xs },
  actionsStacked: { flexDirection: "column" },
  // The primary label is the longer one, so it gets a little more of the row. Below 340 pt or at
  // large text the buttons stack, each full width.
  btn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14 },
  btnPrimary: { backgroundColor: color.card, flexGrow: 1.25 },
  btnPrimaryText: { fontFamily: font.bold, fontSize: 15, color: color.night, flexShrink: 1, textAlign: "center" },
  btnSecondary: { backgroundColor: "rgba(255,255,255,0.15)", borderWidth: HAIRLINE, borderColor: "rgba(255,255,255,0.25)" },
  btnSecondaryText: { fontFamily: font.semibold, fontSize: 15, color: color.onDark, flexShrink: 1, textAlign: "center" },
  pressed: { opacity: 0.85 },

  // Quick stats (§4C)
  stats: { flexDirection: "row", backgroundColor: color.card, borderRadius: 16, borderWidth: HAIRLINE, borderColor: color.line, paddingVertical: space.lg, paddingHorizontal: space.sm },
  stat: { flex: 1, alignItems: "center", gap: 2, paddingHorizontal: 4 },
  statValue: { fontFamily: font.score, fontSize: 22, lineHeight: 26, color: color.ink },
  statValueNarrow: { fontSize: 18, lineHeight: 22 },
  statLabel: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: color.muted, textAlign: "center" },
  statRule: { width: HAIRLINE, backgroundColor: color.line, marginVertical: 2 },
  statsStacked: { flexDirection: "column", paddingHorizontal: space.lg, paddingVertical: space.sm },
  statRow: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: space.md, paddingVertical: space.sm },
  statRuleH: { height: HAIRLINE, backgroundColor: color.line },

  gallery: { gap: 10, paddingRight: space.lg },
  photo: { width: 240, gap: 6 },
  photoImg: { width: 240, height: 160, borderRadius: radius.md, backgroundColor: color.line },
  photoCaption: { paddingHorizontal: 2 },

  // Sections (§4D–H)
  section: { gap: space.sm },
  sectionHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md, flexWrap: "wrap" },
  eyebrow: { fontFamily: font.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.8, textTransform: "uppercase", color: color.ink },
  sectionAside: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: color.muted },
  card: { backgroundColor: color.card, borderRadius: 16, borderWidth: HAIRLINE, borderColor: color.line, padding: space.lg },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 22, color: color.ink },

  ratesNote: { fontFamily: font.regular, fontSize: 14, lineHeight: 19, color: color.muted },
  rateGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  rateCard: { flexGrow: 1, flexBasis: "45%", gap: 2 },
  rateCardFull: { flexBasis: "100%" },
  rateTitle: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: color.ink },
  ratePeriod: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: color.muted },
  rateCourt: { fontFamily: font.semibold, fontSize: 13, lineHeight: 17, color: color.cedarDeep },
  rateLine: { flexDirection: "row", alignItems: "baseline", gap: 4, marginTop: space.sm },
  ratePrice: { fontFamily: font.score, fontSize: 30, lineHeight: 34, letterSpacing: -0.5, color: color.ink },
  rateUnit: { fontFamily: font.regular, fontSize: 14, lineHeight: 19, color: color.muted },

  locationRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  locationIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: color.cedarSoft, alignItems: "center", justifyContent: "center" },
  locationText: { fontFamily: font.display, fontSize: 16, lineHeight: 22, color: color.ink, flexShrink: 1 },

  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: color.cedarSoft, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  chipText: { fontFamily: font.semibold, fontSize: 14, lineHeight: 18, color: color.cedarDeep },
  notAvailable: { backgroundColor: "#F7F3EB", borderRadius: 10, padding: 10 },
  notAvailableText: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: color.muted },

  courtsCard: { paddingVertical: 0, paddingRight: 0 },
  courtRow: { flexDirection: "row", alignItems: "stretch", gap: space.md },
  courtMark: { width: 28, height: 28, borderRadius: 6, borderWidth: HAIRLINE, borderColor: color.line, alignItems: "center", justifyContent: "center", alignSelf: "center" },
  // The divider runs from the text's left edge to the card's right edge (§4G).
  courtText: { flex: 1, minHeight: 54, justifyContent: "center", paddingVertical: 10, paddingRight: space.lg },
  courtDivider: { borderTopWidth: HAIRLINE, borderTopColor: color.line },
  courtName: { fontFamily: font.display, fontSize: 16, lineHeight: 22, color: color.ink },
  courtDetail: { fontFamily: font.regular, fontSize: 14, lineHeight: 19, color: color.muted },

  rulesCard: { padding: space.xl, gap: space.md },
  rule: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: space.md },
  ruleStacked: { gap: 2 },
  ruleLabel: { fontFamily: font.regular, fontSize: 15, lineHeight: 20, color: color.muted, flexShrink: 0 },
  ruleValue: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: color.ink },
  ruleValueSide: { flex: 1, textAlign: "right" },
  ruleValueStrong: { fontFamily: font.bold },
});
