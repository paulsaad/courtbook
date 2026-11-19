import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { color, font, radius, space, TOUCH } from "../../lib/theme";
import type { OrganiserAction } from "../../lib/gameState";

const LABEL: Partial<Record<OrganiserAction["kind"], string>> = {
  make_private: "Make private", reopen: "Open to players again", cancel: "Cancel this game",
};

/**
 * The organiser's game-wide actions (organiserActions: what the game's state allows; the database
 * decides again). An action the state does not allow is listed with the reason, not as a button.
 * Removing a player is done from the Players list; editing details is not in the app yet.
 * Shown only when game writes are switched on.
 */
export function ManageSheet({ visible, actions, onPick, onClose }: { visible: boolean; actions: OrganiserAction[]; onPick: (k: OrganiserAction["kind"]) => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const rows = actions.filter((a) => LABEL[a.kind]);
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.head}>
          <Text variant="heading" accessibilityRole="header">Manage game</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.close}><Icon name="close" size={22} /></Pressable>
        </View>
        {rows.map((a) => {
          const ink = a.kind === "cancel" ? color.danger : color.ink;
          return a.enabled ? (
            <Pressable key={a.kind} accessibilityRole="button" onPress={() => onPick(a.kind)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: "#F7F4ED" }]}>
              <Text style={[styles.label, { color: ink }]}>{LABEL[a.kind]}</Text>
              <Icon name="chevronRight" size={20} color={color.muted} />
            </Pressable>
          ) : (
            <View key={a.kind} style={styles.row}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[styles.label, { color: color.muted }]}>{LABEL[a.kind]}</Text>
                {a.reason ? <Text variant="caption">{a.reason}</Text> : null}
              </View>
            </View>
          );
        })}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(15,21,18,0.35)" },
  sheet: { backgroundColor: color.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xl, paddingTop: space.lg },
  close: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", marginRight: -space.md },
  row: { minHeight: TOUCH + 8, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.xl, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: "#EEEAE1" },
  label: { flex: 1, fontFamily: font.semibold, fontSize: 16 },
});
