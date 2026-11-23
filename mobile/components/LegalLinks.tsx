import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { LEGAL_PAGES, openLegalPage } from "../lib/legal";
import { color, space, TOUCH } from "../lib/theme";

/** M5: links to the privacy policy, terms and account-deletion page (Help, and the sign-in screen). */
export function LegalLinks({ only, testID = "legal-links" }: { only?: readonly (typeof LEGAL_PAGES)[number]["key"][]; testID?: string }) {
  const pages = only ? LEGAL_PAGES.filter((p) => only.includes(p.key)) : LEGAL_PAGES;
  return (
    <View style={styles.row} testID={testID}>
      {pages.map((p) => (
        <Pressable key={p.key} accessibilityRole="link" accessibilityLabel={p.label} accessibilityHint="Opens in a browser"
                   onPress={() => void openLegalPage(p.url)} style={({ pressed }) => [styles.link, pressed && { opacity: 0.6 }]}
                   testID={`legal-${p.key}`}>
          <Text style={styles.text}>{p.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", columnGap: space.lg },
  link: { minHeight: TOUCH, justifyContent: "center" },
  text: { fontSize: 15, color: color.cedar, fontWeight: "600", textDecorationLine: "underline" },
});
