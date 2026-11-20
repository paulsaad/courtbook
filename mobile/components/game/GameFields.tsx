import type { ReactNode } from "react";
import { Pressable, StyleSheet, Switch, TextInput, View } from "react-native";
import { Text } from "../Text";
import { Icon } from "../Icon";
import { Segmented } from "../Segmented";
import type { JoinMode } from "../../lib/gameTypes";
import { color, font, MAX_FONT_SCALE, radius, space, TOUCH } from "../../lib/theme";

/**
 * The fields shared by Post a game and Edit game (docs/m3/04-ux-spec.md §4.6): players needed,
 * level range, how players join, note. Plain controls on the limestone page, one labelled group each;
 * nothing here decides what is allowed — the screen passes the limits and the server checks again.
 */

export function Field({ label, hint, children }: { label: string; hint?: string | null; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="eyebrow" style={styles.label} accessibilityRole="header">{label}</Text>
      {children}
      {hint ? <Text variant="secondary">{hint}</Text> : null}
    </View>
  );
}

/** − 3 + with the number in scoreboard type. Adjustable for screen readers. */
export function Stepper({ value, min, max, onChange, label, unit, testID }: {
  value: number; min: number; max: number; onChange: (n: number) => void; label: string; unit?: (n: number) => string; testID?: string;
}) {
  const set = (n: number) => onChange(Math.min(max, Math.max(min, n)));
  const spoken = unit ? `${value} ${unit(value)}` : String(value);
  return (
    <View
      style={styles.stepper}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: spoken }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => set(value + (e.nativeEvent.actionName === "increment" ? 1 : -1))}
      testID={testID}
    >
      <StepButton icon="minus" disabled={value <= min} onPress={() => set(value - 1)} testID={testID ? `${testID}-minus` : undefined} />
      <View style={styles.stepValue}>
        <Text style={styles.stepNumber} maxFontSizeMultiplier={1.3}>{value}</Text>
        {unit ? <Text variant="secondary" numberOfLines={1}>{unit(value)}</Text> : null}
      </View>
      <StepButton icon="plus" disabled={value >= max} onPress={() => set(value + 1)} testID={testID ? `${testID}-plus` : undefined} />
    </View>
  );
}

function StepButton({ icon, disabled, onPress, testID }: { icon: "plus" | "minus"; disabled: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.stepBtn, disabled && styles.stepBtnOff, pressed && !disabled && styles.pressed]}
      hitSlop={4}
      testID={testID}
    >
      <Icon name={icon} size={22} color={disabled ? color.booked : color.cedarDeep} strokeWidth={2.2} />
    </Pressable>
  );
}

/** "All levels welcome" switch; off → From / To steppers (1–10, From ≤ To). */
export function LevelRangeField({ min, max, onChange }: { min: number | null; max: number | null; onChange: (min: number | null, max: number | null) => void }) {
  const all = min == null || max == null;
  return (
    <Field label="Level" hint={all ? "Anyone can join, whatever their level." : `Levels ${min}–${max}. Players outside the range are asked to confirm before they join.`}>
      <View style={styles.switchRow}>
        <Text variant="strong" style={{ flex: 1 }}>All levels welcome</Text>
        <Switch
          value={all}
          onValueChange={(v) => (v ? onChange(null, null) : onChange(4, 6))}
          trackColor={{ true: color.cedar, false: color.line }}
          thumbColor={color.card}
          accessibilityLabel="All levels welcome"
          testID="levels-all"
        />
      </View>
      {!all ? (
        <View style={styles.pair}>
          <View style={styles.pairItem}>
            <Text variant="secondary">From</Text>
            <Stepper value={min!} min={1} max={max!} onChange={(n) => onChange(n, max)} label="Lowest level" testID="level-min" />
          </View>
          <View style={styles.pairItem}>
            <Text variant="secondary">To</Text>
            <Stepper value={max!} min={min!} max={10} onChange={(n) => onChange(min, n)} label="Highest level" testID="level-max" />
          </View>
        </View>
      ) : null}
    </Field>
  );
}

export const JOIN_MODE_TEXT: Record<JoinMode, string> = {
  open: "Players join straight away, while there are places.",
  approval: "Players ask to join. You accept or decline each request.",
};

/** The approved choice between joining straight away and asking (approval). */
export function JoinModeField({ value, onChange, note }: { value: JoinMode; onChange: (m: JoinMode) => void; note?: string | null }) {
  return (
    <Field label="How players join" hint={note}>
      <Segmented<JoinMode> options={[{ key: "open", label: "Join straight away" }, { key: "approval", label: "Ask to join" }]} value={value} onChange={onChange} />
      <Text variant="body" testID="join-mode-text">{JOIN_MODE_TEXT[value]}</Text>
    </Field>
  );
}

export function NoteField({ value, onChange, max }: { value: string; onChange: (s: string) => void; max: number }) {
  const left = max - value.length;
  return (
    <Field label="Note (optional)">
      <TextInput
        value={value}
        onChangeText={(t) => onChange(t.slice(0, max))}
        placeholder="Friendly doubles, bring balls…"
        placeholderTextColor={color.booked}
        multiline
        maxLength={max}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        style={styles.note}
        accessibilityLabel="Note for players"
        testID="note"
      />
      <Text variant="caption" style={{ alignSelf: "flex-end" }} accessibilityLiveRegion={left <= 30 ? "polite" : "none"}>
        {left <= 30 ? `${left} characters left` : `${value.length}/${max}`}
      </Text>
    </Field>
  );
}

/** A row in a single-choice list (a club, a booking): whole row tappable, tick when chosen. */
export function ChoiceRow({ title, detail, selected, onPress, disabled, testID }: {
  title: string; detail?: string | null; selected: boolean; onPress: () => void; disabled?: boolean; testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, selected && styles.choiceOn, pressed && styles.pressed, disabled && { opacity: 0.6 }]}
      testID={testID}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="strong">{title}</Text>
        {detail ? <Text variant="secondary">{detail}</Text> : null}
      </View>
      {selected ? <Icon name="check" size={22} color={color.cedar} strokeWidth={2.4} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.sm },
  label: { color: color.ink },
  stepper: { flexDirection: "row", alignItems: "center", gap: space.md, alignSelf: "flex-start" },
  stepBtn: {
    width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: "center", justifyContent: "center",
    backgroundColor: color.card, borderWidth: 1, borderColor: color.line,
  },
  stepBtnOff: { backgroundColor: color.ground },
  stepValue: { minWidth: 56, alignItems: "center" },
  stepNumber: { fontFamily: font.score, fontSize: 34, lineHeight: 38, color: color.ink },
  pressed: { opacity: 0.7 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH },
  pair: { flexDirection: "row", flexWrap: "wrap", gap: space.xl },
  pairItem: { gap: space.xs },
  note: {
    minHeight: 88, maxHeight: 160, textAlignVertical: "top", backgroundColor: color.card, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.line, padding: space.md, fontFamily: font.regular, fontSize: 16, lineHeight: 22, color: color.ink,
  },
  choice: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 8, paddingHorizontal: space.lg, paddingVertical: space.md,
    backgroundColor: color.card, borderRadius: radius.md, borderWidth: 1, borderColor: color.line,
  },
  choiceOn: { borderColor: color.cedar, borderWidth: 2 },
});
