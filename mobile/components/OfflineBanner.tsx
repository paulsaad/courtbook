import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { onlineManager } from "@tanstack/react-query";
import { color, space } from "../lib/theme";

/**
 * Floats over the top of the screen only while the phone is offline; renders nothing otherwise,
 * so it never shifts layout. What was already loaded stays on screen underneath.
 */
export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const [online, setOnline] = useState(onlineManager.isOnline());
  useEffect(() => onlineManager.subscribe(setOnline), []);
  if (online) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      pointerEvents="none"
      style={[styles.bar, { paddingTop: insets.top + space.xs }]}
    >
      <Text style={styles.text}>You're offline. Showing what was last loaded.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", top: 0, left: 0, right: 0, zIndex: 10, backgroundColor: color.ink, paddingBottom: space.sm, paddingHorizontal: space.lg },
  text: { color: color.onDark, fontSize: 13, fontWeight: "600", textAlign: "center" },
});
