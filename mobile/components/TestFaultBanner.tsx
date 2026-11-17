import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FAULT_LABEL, currentFault, subscribeFault } from "../lib/testFaults";
import { color } from "../lib/theme";

/** While a test fault is on, a strip at the bottom of every screen says so — it cannot be forgotten. */
export function TestFaultBanner() {
  const insets = useSafeAreaInsets();
  const fault = useSyncExternalStore(subscribeFault, currentFault);
  if (fault === "off") return null;
  return (
    <View pointerEvents="none" style={[styles.bar, { paddingBottom: insets.bottom + 2 }]} accessibilityRole="alert">
      <Text style={styles.text}>Test mode: {FAULT_LABEL[fault].toLowerCase()} — Profile → Test tools to turn off</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 20, backgroundColor: color.warnInk, paddingTop: 4, paddingHorizontal: 12 },
  text: { color: color.onDark, fontSize: 12, fontWeight: "700", textAlign: "center" },
});
