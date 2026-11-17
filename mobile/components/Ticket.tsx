import { StyleSheet, View } from "react-native";
import type { ReactNode } from "react";
import { Text } from "./Text";
import { CourtLines } from "./CourtLines";
import { SportMark } from "./SportMark";
import { color, font, radius } from "../lib/theme";

/**
 * A booking, drawn as a ticket: a red edge, a dark band with the date and the time set like a
 * scoreboard, a red perforation, then the details on white. The details are passed in as rows so the
 * payment and cancellation wording always comes from the booking itself, never from this component.
 *
 * The time range has a column of its own and the court marking a fixed column beside it, in a plain
 * row with nothing wrapping and nothing aligned on baselines: the start time on one line, "to <end>"
 * always on the line below. Nothing can be drawn over the times at any width or text size. (The
 * previous layout put both times in one wrapping, baseline-aligned row; on the iPhone the end time
 * was partly hidden on the iPhone although a browser build laid it out correctly — Paul's test,
 * 2026-11-14. Baseline alignment inside a wrapping row is where the phone's layout engine and the
 * browser's differ, so that combination is gone rather than tuned.)
 */
export function Ticket({ date, start, end, sport, children }: { date: string; start: string; end?: string; sport?: { key: string; label: string }; children: ReactNode }) {
  return (
    <View style={styles.card} accessibilityLabel={`${date}, ${start}${end ? ` to ${end}` : ""}`}>
      <View style={styles.edge} />
      <View style={styles.band}>
        <View style={styles.bandTop}>
          <Text style={styles.date}>{date.toUpperCase()}</Text>
          {sport ? (
            <View style={styles.sport}>
              <SportMark sport={sport.key} size={16} color={color.redOnDark} />
              <Text style={styles.sportText}>{sport.label}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.bottomRow}>
          <View style={styles.times} testID="ticket-times">
            <Text style={styles.start} testID="ticket-start">{start}</Text>
            {end ? <Text style={styles.end} testID="ticket-end">to {end}</Text> : null}
          </View>
          <View style={styles.mark} testID="ticket-mark" accessible={false} importantForAccessibility="no-hide-descendants">
            <CourtLines inline width={64} height={52} opacity={0.22} />
          </View>
        </View>
      </View>
      <View style={styles.perforation} accessible={false} testID="ticket-perforation">
        <View style={[styles.notch, styles.notchLeft]} />
        <View style={styles.dashes} />
        <View style={[styles.notch, styles.notchRight]} />
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
  edge: { height: 6, backgroundColor: color.red },
  // No overflow clipping: nothing floats in the band any more, and a text the phone measures a little
  // larger than expected must show in full rather than be cut off at the perforation.
  band: { backgroundColor: color.night, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 16 },
  bandTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  date: { flexShrink: 1, fontFamily: font.bold, fontSize: 14, letterSpacing: 0.8, color: color.redOnDark },
  sport: { flexDirection: "row", alignItems: "center", gap: 5, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.10)" },
  sportText: { fontFamily: font.bold, fontSize: 13, color: color.onDark },
  perforation: { height: 2, justifyContent: "center" },
  dashes: { marginHorizontal: 16, borderTopWidth: 2, borderStyle: "dashed", borderColor: color.red },
  notch: { position: "absolute", top: -10, width: 20, height: 20, borderRadius: 10, backgroundColor: color.ground, borderColor: color.line },
  notchLeft: { left: -11, borderRightWidth: 1 },
  notchRight: { right: -11, borderLeftWidth: 1 },
  bottomRow: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 4 },
  times: { flex: 1, minWidth: 0 },
  mark: { width: 64, height: 52, flexShrink: 0 },
  start: { fontFamily: font.score, fontSize: 60, lineHeight: 64, color: color.onDark },
  end: { fontFamily: font.scoreSemi, fontSize: 26, lineHeight: 30, color: color.onDarkMuted },
  body: { paddingHorizontal: 20, paddingVertical: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, paddingVertical: 12 },
  rowRule: { borderBottomWidth: 1, borderBottomColor: "#EEEAE1" },
  rowValue: { flexShrink: 1, alignItems: "flex-end" },
});
