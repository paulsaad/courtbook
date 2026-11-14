import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { color, space, text, MAX_FONT_SCALE } from "../lib/theme";
import { classify } from "../lib/errors";

/** Loading, empty and error states share one layout so every screen handles all three the same way. */
export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <View style={styles.wrap} accessibilityLabel={label}>
      <ActivityIndicator color={color.cedar} />
    </View>
  );
}

export function Empty({ title, body, action, onAction }: { title: string; body?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.wrap}>
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.title}>{title}</Text>
      {body ? <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>{body}</Text> : null}
      {action && onAction ? <Button label={action} onPress={onAction} /> : null}
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const f = classify(error);
  return (
    <View style={styles.wrap} accessibilityRole="alert">
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.title}>{f.kind === "network" ? "No connection" : "Couldn't load this"}</Text>
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>{f.message}</Text>
      {onRetry && f.kind !== "auth" ? <Button label="Try again" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.xxl, gap: space.md, alignItems: "stretch", justifyContent: "center" },
  title: { ...text.heading, color: color.ink, textAlign: "center" },
  body: { ...text.body, color: color.muted, textAlign: "center" },
});
