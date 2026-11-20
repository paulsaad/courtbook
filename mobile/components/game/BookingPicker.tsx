import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatInTimeZone } from "date-fns-tz";
import { hhmm } from "@shared/time";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { useAgenda } from "../../lib/bookings";
import { sportName } from "../../lib/days";
import { color, font, radius, space, TOUCH } from "../../lib/theme";

/**
 * GR-9 "Link another existing booking": the organiser's own upcoming confirmed bookings (my_agenda,
 * the M2 list). Picking one only links it — resolve_court checks it is theirs, confirmed, in the
 * future, the same sport and not linked to another game, and refuses otherwise. Nothing is booked.
 * Shown only when game writes are switched on.
 */
export function BookingPicker({ visible, sport, onPick, onClose }: { visible: boolean; sport: string; onPick: (bookingId: string) => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const agenda = useAgenda(visible);
  const now = Date.now();
  const rows = (agenda.data ?? []).filter((r) => r.kind === "booking" && r.status === "confirmed" && new Date(r.start_at).getTime() > now);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.head}>
          <Text variant="heading" accessibilityRole="header">Link a booking</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.close}><Icon name="close" size={22} /></Pressable>
        </View>
        <Text variant="secondary" style={styles.intro}>{`Your upcoming ${sportName(sport).toLowerCase()} bookings. The game moves to the booking's time and court.`}</Text>
        <ScrollView>
          {rows.map((r) => (
            <Pressable key={r.id} accessibilityRole="button" onPress={() => onPick(r.id)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: "#F7F4ED" }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="strong">{`${formatInTimeZone(new Date(r.start_at), r.timezone, "EEE d MMM")} · ${hhmm(r.start_at, r.timezone)}${r.end_at ? `–${hhmm(r.end_at, r.timezone)}` : ""}`}</Text>
                <Text variant="secondary">{[r.club_name, r.title].filter(Boolean).join(" · ")}</Text>
              </View>
              <Icon name="chevronRight" size={20} color={color.muted} />
            </Pressable>
          ))}
          {agenda.isSuccess && rows.length === 0 ? <Text variant="secondary" style={styles.intro}>You have no upcoming confirmed bookings.</Text> : null}
          {agenda.isPending ? <Text variant="secondary" style={styles.intro}>Loading your bookings…</Text> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(15,21,18,0.35)" },
  sheet: { maxHeight: "75%", backgroundColor: color.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xl, paddingTop: space.lg },
  close: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", marginRight: -space.md },
  intro: { paddingHorizontal: space.xl, paddingVertical: space.sm },
  row: { minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.xl, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: "#EEEAE1" },
  label: { fontFamily: font.semibold },
});
