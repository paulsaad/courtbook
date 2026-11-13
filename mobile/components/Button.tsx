import { ActivityIndicator, Pressable, StyleSheet, Text, type PressableProps } from "react-native";
import { color, radius, TOUCH, MAX_FONT_SCALE } from "../lib/theme";

type Props = Omit<PressableProps, "children" | "style"> & {
  label: string;
  variant?: "primary" | "secondary" | "quiet";
  busy?: boolean;
};

/**
 * The one button. While `busy`, it ignores presses and says so to screen readers — the first line
 * of defence against a second tap; the database's idempotency is the real one.
 */
export function Button({ label, variant = "primary", busy = false, disabled, onPress, ...rest }: Props) {
  const inactive = busy || !!disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [styles.base, styles[variant], inactive && styles.inactive, pressed && !inactive && styles.pressed]}
      {...rest}
    >
      {busy ? (
        <ActivityIndicator color={variant === "primary" ? color.onDark : color.ink} />
      ) : (
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.text, variant === "primary" ? styles.textOnPrimary : styles.textPlain]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: TOUCH + 4, borderRadius: radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  primary: { backgroundColor: color.cedar },
  secondary: { backgroundColor: color.card, borderWidth: 1, borderColor: color.line },
  quiet: { backgroundColor: "transparent" },
  inactive: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  text: { fontSize: 16, fontWeight: "700" },
  textOnPrimary: { color: color.onDark },
  textPlain: { color: color.ink },
});
