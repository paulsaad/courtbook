import type { ReactNode } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { feeSummary } from "@shared/fees";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { SportMark } from "./SportMark";
import { CourtLines } from "./CourtLines";
import { Empty, ErrorState, Loading } from "./StateView";
import {
  clubSports, courtLine, facilityGroups, imageUrl, infoDuration, lengthRange, mapsUrl, missingSentence, priceRow,
  type ClubInfo,
} from "../lib/clubInfo";
import { sportName } from "../lib/days";
import { color, font, radius, space } from "../lib/theme";
import { haptic } from "../lib/haptics";

/**
 * The club's Info tab: what a player wants to know before going — where it is, what is there, what it
 * costs and the house rules. Same content and wording as the website's Info page; a section the club
 * has not filled in is left out rather than shown empty.
 */
export function ClubInfoView({ query, onBook }: {
  query: { data?: ClubInfo; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  onBook: () => void;
}) {
  if (query.isPending) return <Loading label="Loading club details" />;
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Empty title="Club not found" body="It may no longer take bookings." />;

  const { club, courts, rules, gallery } = query.data;
  const cover = imageUrl(club.cover_url);
  const sports = clubSports(courts);
  const maps = mapsUrl(club);
  const { has, hasNot } = facilityGroups(club);
  const missing = missingSentence(hasNot);
  const fees = feeSummary(club.payment_mode, club.service_fee_usd);
  const length = lengthRange(club.min_booking_minutes, club.max_booking_minutes);

  const openMaps = () => { if (maps) { haptic.select(); void Linking.openURL(maps); } };

  return (
    <View style={styles.wrap}>
      {/* Hero: the club's own photo when it has one, otherwise its court marking on night green. */}
      <View style={[styles.hero, !cover && styles.heroEdge]}>
        {cover && (
          <Image source={{ uri: cover }} style={styles.cover} contentFit="cover" transition={200} accessibilityLabel={`${club.name}, main photo`} />
        )}
        <View style={styles.heroBody}>
          <View style={styles.heroTop}>
            <View style={styles.sportRow}>
              {sports.map((s) => (
                <View key={s} style={styles.sportTag}>
                  <SportMark sport={s} size={16} color={color.redOnDark} />
                  <Text style={styles.sportText}>{sportName(s)}</Text>
                </View>
              ))}
            </View>
            {/* No photo yet: the court marking stands in, beside the sports — never under any text. */}
            {!cover && <CourtLines inline opacity={0.22} width={66} height={54} />}
          </View>
          <Text style={styles.heroName} accessibilityRole="header">{club.name}</Text>
          {(club.town?.name_en || club.address) && (
            <View style={styles.placeRow}>
              <Icon name="pin" size={16} color={color.onDarkMuted} />
              <Text style={styles.placeText} numberOfLines={2}>{[club.town?.name_en, club.address].filter(Boolean).join(" · ")}</Text>
            </View>
          )}
          {club.is_demo && (
            <View style={styles.demoPill}><Text style={styles.demoText}>Demo club — not a real venue</Text></View>
          )}
          <View style={styles.heroActions}>
            <Pressable accessibilityRole="button" onPress={onBook} style={({ pressed }) => [styles.heroBtn, styles.heroBook, pressed && styles.pressed]}>
              <Icon name="calendar" size={18} color={color.onDark} />
              <Text style={styles.heroBookText} numberOfLines={1}>Free times</Text>
            </Pressable>
            {maps && (
              <Pressable accessibilityRole="link" accessibilityHint="Opens the map" onPress={openMaps} style={({ pressed }) => [styles.heroBtn, styles.heroMap, pressed && styles.pressed]}>
                <Icon name="pin" size={18} color={color.ink} />
                <Text style={styles.heroMapText} numberOfLines={1}>Directions</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* The three numbers players ask about first, scoreboard style. */}
      <View style={styles.facts}>
        <Fact wide label="Open daily" value={`${club.open_time.slice(0, 5)}–${club.close_time.slice(0, 5)}`} />
        <View style={styles.factRule} />
        <Fact label="Play" value={length} />
        <View style={styles.factRule} />
        <Fact label="Free cancellation" value={`${club.cancel_cutoff_hours} h before`} />
      </View>

      {gallery.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gallery} accessibilityLabel="Photos">
          {gallery.map((m, i) => {
            const uri = imageUrl(m);
            if (!uri) return null;
            return (
              <View key={m.id} style={styles.photo}>
                <Image source={{ uri }} style={styles.photoImg} contentFit="cover" transition={200} accessibilityLabel={m.caption ?? `${club.name}, photo ${i + 1}`} />
                {m.caption && <Text variant="caption" numberOfLines={1} style={styles.photoCaption}>{m.caption}</Text>}
              </View>
            );
          })}
        </ScrollView>
      )}

      {club.description && (
        <Section title="About">
          <Text variant="body" style={styles.prose}>{club.description}</Text>
        </Section>
      )}

      {(club.address || club.arrival_notes || maps) && (
        <Section title="Getting there">
          {club.address && <Text variant="strong">{club.address}</Text>}
          {club.arrival_notes && <Text variant="secondary" style={styles.prose}>{club.arrival_notes}</Text>}
          {maps && (
            <Pressable accessibilityRole="link" onPress={openMaps} style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}>
              <Text style={styles.link}>Open in Maps</Text>
              <Icon name="chevronRight" size={18} color={color.cedarDeep} />
            </Pressable>
          )}
        </Section>
      )}

      {(has.length > 0 || missing) && (
        <Section title="Facilities">
          {has.length > 0 && (
            <View style={styles.facilityWrap}>
              {has.map((label) => (
                <View key={label} style={styles.facility}>
                  <Icon name="check" size={15} color={color.cedarDeep} strokeWidth={2.4} />
                  <Text style={styles.facilityText}>{label}</Text>
                </View>
              ))}
            </View>
          )}
          {missing && <Text variant="caption">{missing}</Text>}
        </Section>
      )}

      {courts.length > 0 && (
        <Section title="Courts">
          {courts.map((c, i) => (
            <Row key={c.id} first={i === 0} left={
              <View style={styles.courtLeft}>
                <SportMark sport={c.sport} size={22} />
                <Text variant="strong" style={{ flexShrink: 1 }}>{c.name}</Text>
              </View>
            } right={<Text variant="secondary" style={styles.right}>{courtLine(c)}</Text>} />
          ))}
        </Section>
      )}

      <Section title="Prices per hour">
        {rules.length === 0 ? (
          <Text variant="secondary">Prices shown when you pick a time.</Text>
        ) : (
          rules.map((r, i) => {
            const row = priceRow(r, courts);
            return (
              <Row key={i} first={i === 0} left={
                <View style={{ flexShrink: 1 }}>
                  <Text style={styles.when}>{row.when}</Text>
                  {row.note && <Text variant="caption">{row.note}</Text>}
                </View>
              } right={<Text style={styles.price}>{row.price}</Text>} />
            );
          })
        )}
      </Section>

      <Section title="Booking">
        <Row fixed first left={<Text variant="secondary">Book ahead</Text>} right={<Text variant="label" style={styles.right}>up to {club.booking_window_days} days</Text>} />
        <Row fixed left={<Text variant="secondary">Booking length</Text>} right={<Text variant="label" style={styles.right}>{infoDuration(club.min_booking_minutes)} to {infoDuration(club.max_booking_minutes)}, {club.slot_minutes}-min steps</Text>} />
        <Row fixed left={<Text variant="secondary">Free cancellation</Text>} right={<Text variant="label" style={styles.right}>until {club.cancel_cutoff_hours} h before; no refund after</Text>} />
        <Row fixed left={<Text variant="secondary">Booking fee</Text>} right={<Text variant="label" style={styles.right}>{fees.fee}</Text>} />
        {fees.payment && <Row fixed left={<Text variant="secondary">Payment</Text>} right={<Text variant="label" style={styles.right}>{fees.payment}</Text>} />}
      </Section>
    </View>
  );
}

/** `wide`: the opening hours ("08:00–23:00") get a little more room, so they never shrink or cut off. */
function Fact({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <View style={[styles.fact, wide && { flex: 1.3 }]} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={styles.factValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{value}</Text>
      <Text variant="caption" numberOfLines={2} style={{ textAlign: "center" }}>{label}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="eyebrow" accessibilityRole="header">{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

/** A two-sided row. `fixed`: the label keeps its width and the value wraps instead. */
function Row({ left, right, first = false, fixed = false }: { left: ReactNode; right: ReactNode; first?: boolean; fixed?: boolean }) {
  return (
    <View style={[styles.row, !first && styles.rowRule]}>
      <View style={fixed ? { flexShrink: 0 } : { flexShrink: 1 }}>{left}</View>
      <View style={fixed ? { flex: 1, alignItems: "flex-end" } : { flexShrink: 1, maxWidth: "60%", alignItems: "flex-end" }}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.xl },
  hero: { backgroundColor: color.night, borderRadius: radius.xl, overflow: "hidden" },
  heroEdge: { borderTopWidth: 4, borderTopColor: color.red },
  cover: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "#0B3A27" },
  heroBody: { padding: space.xl, paddingTop: space.lg, gap: space.sm },
  heroTop: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  sportRow: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 12, paddingTop: 2 },
  sportTag: { flexDirection: "row", alignItems: "center", gap: 6 },
  sportText: { fontFamily: font.bold, fontSize: 14, letterSpacing: 0.6, textTransform: "uppercase", color: color.redOnDark },
  // The navigation bar already names the club; here it is the card's title, not the page's.
  heroName: { fontFamily: font.display, fontSize: 22, lineHeight: 27, letterSpacing: -0.2, color: color.onDark },
  placeRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  placeText: { fontFamily: font.medium, fontSize: 15, lineHeight: 20, color: color.onDarkMuted, flexShrink: 1 },
  demoPill: { alignSelf: "flex-start", backgroundColor: color.warnSoft, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, marginTop: 2 },
  demoText: { fontFamily: font.semibold, fontSize: 13, color: color.warnInk },
  // Two equal buttons on one row, down to the iPhone SE; they stack only at very large text sizes.
  heroActions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: space.sm },
  heroBtn: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, paddingHorizontal: 16, borderRadius: radius.md },
  heroBook: { backgroundColor: color.cedar, flexGrow: 1, flexBasis: 120, justifyContent: "center" },
  heroBookText: { fontFamily: font.bold, fontSize: 16, color: color.onDark },
  heroMap: { backgroundColor: color.card, flexGrow: 1, flexBasis: 120, justifyContent: "center" },
  heroMapText: { fontFamily: font.bold, fontSize: 16, color: color.ink },
  pressed: { opacity: 0.85 },
  facts: { flexDirection: "row", backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, paddingVertical: 14 },
  fact: { flex: 1, alignItems: "center", gap: 2, paddingHorizontal: 6 },
  factValue: { fontFamily: font.score, fontSize: 20, lineHeight: 24, color: color.ink },
  factRule: { width: 1, backgroundColor: color.line, marginVertical: 2 },
  gallery: { gap: 10, paddingRight: space.lg },
  photo: { width: 240, gap: 6 },
  photoImg: { width: 240, height: 160, borderRadius: radius.md, backgroundColor: color.line },
  photoCaption: { paddingHorizontal: 2 },
  section: { gap: space.sm },
  card: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  prose: { lineHeight: 23 },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44 },
  link: { fontFamily: font.bold, fontSize: 16, color: color.cedarDeep },
  facilityWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  facility: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: color.cedarSoft, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 },
  facilityText: { fontFamily: font.semibold, fontSize: 14, color: color.cedarDeep },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md, paddingVertical: 10 },
  rowRule: { borderTopWidth: 1, borderTopColor: color.line },
  right: { textAlign: "right" },
  courtLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  when: { fontFamily: font.scoreSemi, fontSize: 18, lineHeight: 22, color: color.ink },
  price: { fontFamily: font.score, fontSize: 22, lineHeight: 26, color: color.ink },
});
