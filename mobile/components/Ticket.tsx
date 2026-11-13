import { StyleSheet, View } from "react-native";
import type { ReactNode } from "react";
import { Text } from "./Text";
import { CourtLines } from "./CourtLines";
import { color, font, radius } from "../lib/theme";

/**
 * A booking, drawn as a ticket: a dark band with the date and the time set like a scoreboard,
 * then the details on white. The details are passed in as rows so the payment and cancellation
 * wording always comes from the booking itself, never from this component.
 */
export function Ticket({ date, start, end, children }: { date: string; start: string; end?: string; children: ReactNode }) {
  return (
    <View style={styles.card} accessibilityLabel={`${date}, ${start}${end ? ` to ${end}` : ""}`}>
      <View style={styles.band}>
        <CourtLines />
        <Text style={styles.date}>{date}</Text>
        <View style={styles.timeRow}>
          <Text style={styles.start}>{start}</Text>
          {end ? <Text style={styles.end}>to {end}</Text> : null}
        </View>
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

export function TicketRow({ label, value, note, last = false }: { label: string; value: string; note?: string; last?: boolean }) {
  return (
    <View style={[styles.row, !last && styles.rowRule]}>
      <Text variant="secondary">{label}</Text>
      <View style={styles.rowValue}>
        <Text variant="strong" style={{ textAlign: "right" }}>{value}</Text>
        {note ? <Text variant="caption" style={{ textAlign: "right" }}>{note}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.xl, backgroundColor: color.card, borderWidth: 1, borderColor: color.line, overflow: "hidden" },
  band: { backgroundColor: color.night, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 16, overflow: "hidden" },
  date: { fontFamily: font.semibold, fontSize: 15, color: color.onDarkMuted },
  timeRow: { flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 4 },
  start: { fontFamily: font.score, fontSize: 60, lineHeight: 62, color: color.onDark },
  end: { fontFamily: font.scoreSemi, fontSize: 26, color: color.onDarkMuted },
  body: { paddingHorizontal: 20, paddingVertical: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, paddingVertical: 12 },
  rowRule: { borderBottomWidth: 1, borderBottomColor: "#EEEAE1" },
  rowValue: { flexShrink: 1, alignItems: "flex-end" },
});
