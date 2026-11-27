import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GROUP_LABEL, GUIDE, levelGroup } from "@shared/levels";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { useSaveLevel } from "../lib/myProfile";
import { color, font, MAX_FONT_SCALE, radius, space, TOUCH } from "../lib/theme";

/**
 * One sport's level, 1–10 — the website's level sheet in the app: ten rows with number, group and the guide's
 * description; nothing is written until "Save level"; "Clear level" (or "Not sure yet") removes it. A failed save keeps
 * the choice and says so. Optional: a level is never needed to book a court.
 */
export function LevelSheet({ sport, sportName, current, onClose }: { sport: string | null; sportName: string; current: number | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const save = useSaveLevel();
  const [pick, setPick] = useState<number | null>(current);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { setPick(current); setProblem(null); }, [sport, current]);
  const guide = sport ? GUIDE[sport] : undefined;
  const rows = guide?.levels ?? Array.from({ length: 10 }, (_, i) => ({ level: i + 1, text: "" }));

  const write = async (level: number | null) => {
    if (!sport) return;
    setProblem(null);
    try { await save.mutateAsync({ sport, level }); onClose(); }
    catch { setProblem("Not saved. Check your connection and try again."); }
  };
  const close = () => { if (!save.isPending) onClose(); };

  return (
    <Modal visible={!!sport} animationType="slide" transparent onRequestClose={close}>
      <Pressable style={styles.scrim} onPress={close} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]} testID="level-sheet">
        <View style={styles.head}>
          <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>{sportName} level</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={close} style={styles.close}><Icon name="close" size={22} /></Pressable>
        </View>
        <Text variant="secondary" style={styles.lead}>Choose what you can do consistently in a game. Optional — it helps other players find a game that suits you.</Text>
        <ScrollView contentContainerStyle={styles.list} accessibilityRole="radiogroup">
          {rows.map(({ level, text }) => {
            const on = pick === level;
            return (
              <Pressable key={level} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`Level ${level}, ${GROUP_LABEL[levelGroup(level)!]}${text ? `. ${text}` : ""}`}
                         onPress={() => setPick(level)} style={[styles.row, on && styles.rowOn]} testID={`level-${level}`}>
                <View style={[styles.num, on && styles.numOn]}><Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.numText, on && { color: color.onDark }]}>{level}</Text></View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="label">{GROUP_LABEL[levelGroup(level)!]}</Text>
                  {text ? <Text variant="secondary">{text}</Text> : null}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={styles.foot}>
          {problem ? <Text style={{ color: color.danger }} accessibilityRole="alert">{problem}</Text> : null}
          <Button label="Save level" busy={save.isPending} disabled={pick == null || pick === current} onPress={() => void write(pick)} testID="level-save" />
          <Button label={current != null ? "Clear level" : "Not sure yet"} variant="quiet" disabled={save.isPending} onPress={() => (current != null ? void write(null) : close())} testID="level-clear" />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(15,21,18,0.35)" },
  sheet: { backgroundColor: color.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, maxHeight: "90%" },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.xl, paddingTop: space.lg },
  close: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", marginRight: -space.md },
  lead: { paddingHorizontal: space.xl },
  list: { padding: space.xl, gap: space.sm },
  row: { flexDirection: "row", gap: space.md, alignItems: "flex-start", borderWidth: 1, borderColor: color.line, borderRadius: radius.md, padding: space.md, minHeight: TOUCH },
  rowOn: { borderColor: color.ink, borderWidth: 2 },
  num: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: color.cedarSoft },
  numOn: { backgroundColor: color.cedar },
  numText: { fontFamily: font.score, fontSize: 20, color: color.cedarDeep },
  foot: { paddingHorizontal: space.xl, paddingTop: space.sm, gap: space.sm, borderTopWidth: 1, borderTopColor: color.line },
});
