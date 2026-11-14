import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { Icon } from "./Icon";
import { describeFreshness } from "../lib/freshness";
import { color } from "../lib/theme";

/**
 * "Checked just now", driven by the time of the last successful fetch, re-evaluated every few
 * seconds so the words age honestly while the screen stays open.
 */
export function Freshness({ lastSuccessAt, fetching, failedSinceSuccess }: { lastSuccessAt: number; fetching: boolean; failedSinceSuccess: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const f = describeFreshness({ lastSuccessAt, now, fetching, failedSinceSuccess });
  const tint = f.tone === "ok" ? color.cedarDeep : f.tone === "failed" ? color.danger : color.muted;
  return (
    <View style={styles.row} accessibilityLiveRegion="polite">
      <Icon name={f.tone === "ok" ? "check" : "clock"} size={16} color={tint} strokeWidth={2.2} />
      <Text variant="caption" style={{ color: tint }}>{f.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: "row", alignItems: "center", gap: 6 } });
