import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { Button } from "../Button";
import { ChoiceRow } from "./GameFields";
import {
  COMMUNITY_RULES, REPORT_BLOCK_OFFER, REPORT_DANGER, REPORT_NOTE_MAX, REPORT_REASONS, REPORT_THANKS, type ReportReason,
} from "../../lib/safety";
import { color, font, MAX_FONT_SCALE, radius, space, TOUCH } from "../../lib/theme";

function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.head}>
          <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.close}><Icon name="close" size={22} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

/**
 * Report (UX §4.6): a reason, an optional note, "Send report". After sending: the thanks sentence,
 * the emergency line for "Threat or danger", and — for a message or a player — the offer to block.
 * No response time is promised.
 */
export function ReportSheet({ visible, what, onSend, onBlock, onClose }: {
  visible: boolean; what: string; onSend: (reason: ReportReason, note: string) => Promise<string | null>;
  onBlock?: () => void; onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => { setReason(null); setNote(""); setSent(false); setProblem(null); onClose(); };
  const send = async () => {
    if (!reason || busy) return;
    setBusy(true); setProblem(null);
    const p = await onSend(reason, note);
    setBusy(false);
    if (p) setProblem(p); else setSent(true);
  };
  return (
    <Sheet visible={visible} title={sent ? "Report sent" : `Report ${what}`} onClose={close}>
      {sent ? (
        <>
          <Text variant="body" accessibilityLiveRegion="polite">{REPORT_THANKS}{onBlock ? ` ${REPORT_BLOCK_OFFER}` : ""}</Text>
          {reason === "danger" ? <Text variant="strong">{REPORT_DANGER}</Text> : null}
          {onBlock ? <Button label="Block this player" variant="secondary" onPress={() => { onBlock(); close(); }} /> : null}
          <Button label="Done" variant="quiet" onPress={close} />
        </>
      ) : (
        <>
          {REPORT_REASONS.map((r) => <ChoiceRow key={r.key} title={r.label} selected={reason === r.key} onPress={() => setReason(r.key)} testID={`reason-${r.key}`} />)}
          <TextInput
            value={note} onChangeText={(t) => setNote(t.slice(0, REPORT_NOTE_MAX))} placeholder="Anything else we should know (optional)"
            placeholderTextColor={color.booked} multiline maxLength={REPORT_NOTE_MAX} maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={styles.note} accessibilityLabel="Note for the report"
          />
          {problem ? <Text style={{ color: color.danger }} accessibilityRole="alert">{problem}</Text> : null}
          <Button label="Send report" busy={busy} disabled={!reason} onPress={() => void send()} testID="report-send" />
        </>
      )}
    </Sheet>
  );
}

/** Community rules, once, before the first message (UX §4.6). */
export function RulesSheet({ visible, onAgree, onClose }: { visible: boolean; onAgree: () => Promise<string | null>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Sheet visible={visible} title="Community rules" onClose={onClose}>
      {COMMUNITY_RULES.map((r, i) => (
        <View key={i} style={styles.rule}>
          <Text style={styles.ruleNumber}>{i + 1}</Text>
          <Text variant="body" style={{ flex: 1 }}>{r}</Text>
        </View>
      ))}
      <Text variant="secondary">These rules are part of the CourtBook terms of use.</Text>
      {problem ? <Text style={{ color: color.danger }} accessibilityRole="alert">{problem}</Text> : null}
      <Button label="I agree" busy={busy} onPress={async () => { setBusy(true); const p = await onAgree(); setBusy(false); if (p) setProblem(p); }} testID="rules-agree" />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "rgba(15,21,18,0.35)" },
  sheet: { backgroundColor: color.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, maxHeight: "85%" },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.xl, paddingTop: space.lg },
  close: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", marginRight: -space.md },
  body: { padding: space.xl, gap: space.md },
  note: {
    minHeight: 80, textAlignVertical: "top", backgroundColor: color.ground, borderRadius: radius.md, padding: space.md,
    fontFamily: font.regular, fontSize: 16, lineHeight: 22, color: color.ink,
  },
  rule: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  ruleNumber: { fontFamily: font.score, fontSize: 22, lineHeight: 24, color: color.red, minWidth: 18 },
});
