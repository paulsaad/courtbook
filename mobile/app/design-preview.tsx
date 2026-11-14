import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../components/Text";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { DateStrip, type Day } from "../components/DateStrip";
import { TimeTile } from "../components/TimeTile";
import { Ticket, TicketRow } from "../components/Ticket";
import { Segmented } from "../components/Segmented";
import { SportMark, SPORTS } from "../components/SportMark";
import { Freshness } from "../components/Freshness";
import { Brand } from "../components/Brand";
import { PlayerSlots } from "../components/PlayerSlots";
import { color, space } from "../lib/theme";

/**
 * The approved Court Lines components on a real phone, with made-up sample values. Not a product
 * screen: reachable from Profile → About on test builds only, so Paul can judge type sizes,
 * contrast and touch targets on his iPhone before screens are assembled from these parts.
 */
const DAYS: Day[] = ["Today 13", "Sat 14", "Sun 15", "Mon 16", "Tue 17", "Wed 18", "Thu 19"].map((s, i) => {
  const [weekday, day] = s.split(" ");
  return { key: String(i), weekday, day, a11y: `${weekday} ${day} November` };
});
const TILES = [
  { time: "17:00", free: 3 }, { time: "17:30", free: 2 }, { time: "18:00", free: 1 },
  { time: "18:30", free: 0 }, { time: "19:00", free: 2 }, { time: "19:30", free: 1 },
];

export default function DesignPreview() {
  const [day, setDay] = useState("1");
  const [slot, setSlot] = useState(4);
  const [seg, setSeg] = useState<"courts" | "games">("courts");
  const [sport, setSport] = useState("padel");
  const now = Date.now();

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text variant="eyebrow">Sample values only</Text>
      <Brand />
      <Text variant="title">Ready to play?</Text>
      <Text variant="heading">Your next booking</Text>
      <Text>Body text at 16 points, the size everything you read uses.</Text>
      <Text variant="secondary">Secondary text at 15 points in the darker grey.</Text>
      <Text variant="caption">Captions at 13 points, the smallest text in the app.</Text>

      <Section title="Buttons">
        <Button label="Reserve court" onPress={() => {}} />
        <Button label="Directions" variant="secondary" onPress={() => {}} />
        <Button label="Reserving…" busy onPress={() => {}} />
      </Section>

      <Section title="Sports">
        <View style={styles.wrap}>
          {["padel", "tennis", "football"].map((s) => (
            <Chip key={s} tone="sport" label={s[0].toUpperCase() + s.slice(1)} selected={sport === s} onPress={() => setSport(s)} icon={<SportMark sport={s} size={20} />} />
          ))}
        </View>
        <View style={styles.wrap}>
          {SPORTS.map((s) => (
            <View key={s} style={styles.mark}><SportMark sport={s} size={36} /><Text variant="caption">{s}</Text></View>
          ))}
        </View>
      </Section>

      <Section title="Date and times">
        <View style={{ marginHorizontal: -20 }}><DateStrip days={DAYS} selected={day} onSelect={setDay} /></View>
        <View style={styles.grid}>
          {TILES.map((t, i) => (
            <View key={t.time} style={styles.cell}>
              <TimeTile time={t.time} price="$30" freeCourts={t.free} selected={i === slot} onPress={() => setSlot(i)} />
            </View>
          ))}
        </View>
        <Freshness lastSuccessAt={now} fetching={false} failedSinceSuccess={false} />
        <Freshness lastSuccessAt={now - 3 * 60_000} fetching={false} failedSinceSuccess={false} />
        <Freshness lastSuccessAt={now - 2 * 60_000} fetching={false} failedSinceSuccess />
      </Section>

      <Section title="Games">
        <PlayerSlots players={["NH", "RS"]} capacity={4} />
        <PlayerSlots players={["EK", "MT", "JA", "LS"]} capacity={4} />
      </Section>

      <Section title="Lists">
        <Segmented options={[{ key: "courts", label: "Courts · 2" }, { key: "games", label: "Games · 1" }]} value={seg} onChange={setSeg} />
      </Section>

      <Section title="Ticket">
        <Ticket date="Saturday 14 November" start="18:30" end="20:00" sport={{ key: "padel", label: "Padel" }}>
          <TicketRow label="Club" value="Sample Padel Club" />
          <TicketRow label="Court" value="Court 2 · Padel · 1 h 30" />
          <TicketRow label="Payment" value="$30 at the club" note="Nothing was charged in the app" />
          <TicketRow label="Cancellation" value="Free until Sat 12:30" note="6 hours before you play" last />
        </Ticket>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="eyebrow">{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.md, paddingBottom: 64 },
  section: { gap: space.md, marginTop: space.lg },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  mark: { alignItems: "center", width: 72, gap: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cell: { width: "31.5%" },
});
