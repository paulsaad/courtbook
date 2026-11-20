import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Governorate } from "@shared/geo";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { color, font, radius, space, TOUCH } from "../../lib/theme";

/** "Area" label for the filter chip: the district, else the governorate, else "All of Lebanon". */
export function areaLabel(areas: Governorate[] | undefined, governorate: string | null, district: string | null): string {
  if (!governorate && !district) return "All of Lebanon";
  for (const g of areas ?? []) {
    if (district) {
      const d = g.districts.find((x) => x.code === district);
      if (d) return d.name_en;
    } else if (g.code === governorate) return g.name_en;
  }
  return "Area";
}

/**
 * Pick a governorate or one of its districts (the existing areas() model). A plain list in a sheet:
 * every row is a full-width 48 pt target, the current choice is announced as selected and marked
 * with a check, not by colour alone.
 */
export function AreaSheet({ visible, areas, governorate, district, onChoose, onClose }: {
  visible: boolean; areas: Governorate[] | undefined; governorate: string | null; district: string | null;
  onChoose: (governorate: string | null, district: string | null) => void; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const Row = ({ label, selected, indent = false, onPress }: { label: string; selected: boolean; indent?: boolean; onPress: () => void }) => (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
               style={({ pressed }) => [styles.row, indent && styles.indent, pressed && { backgroundColor: "#F7F4ED" }]}>
      <Text style={[styles.rowText, indent && styles.rowTextSub, selected && styles.rowTextOn]}>{label}</Text>
      {selected ? <Icon name="check" size={20} color={color.cedar} strokeWidth={2.4} /> : null}
    </Pressable>
  );
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.head}>
          <Text variant="heading" accessibilityRole="header">Area</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.close}>
            <Icon name="close" size={22} />
          </Pressable>
        </View>
        <ScrollView>
          <Row label="All of Lebanon" selected={!governorate && !district} onPress={() => onChoose(null, null)} />
          {(areas ?? []).map((g) => (
            <View key={g.code}>
              <Row label={g.name_en} selected={governorate === g.code && !district} onPress={() => onChoose(g.code, null)} />
              {g.districts.map((d) => (
                <Row key={d.code} label={d.name_en} indent selected={district === d.code} onPress={() => onChoose(g.code, d.code)} />
              ))}
            </View>
          ))}
          {!areas ? <Text variant="secondary" style={{ padding: space.lg }}>Loading areas…</Text> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(15,21,18,0.35)" },
  sheet: { maxHeight: "75%", backgroundColor: color.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.sm },
  close: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", marginRight: -space.md },
  row: { minHeight: TOUCH, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, paddingHorizontal: space.xl, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: "#EEEAE1" },
  indent: { paddingLeft: space.xl + space.lg },
  rowText: { flex: 1, fontFamily: font.semibold, fontSize: 16, color: color.ink },
  rowTextSub: { fontFamily: font.regular, color: color.ink },
  rowTextOn: { fontFamily: font.bold, color: color.cedarDeep },
});
