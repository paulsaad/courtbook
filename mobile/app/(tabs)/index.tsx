import { ScrollView, StyleSheet, Text } from "react-native";
import { color, space, text, MAX_FONT_SCALE } from "../../lib/theme";

/** Placeholder until the Home design is approved (M2). */
export default function Home() {
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.title}>Home</Text>
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>
        This screen is built once its design is approved. Courts shows today's real availability in the meantime.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.md },
  title: { ...text.title, color: color.ink },
  body: { ...text.body, color: color.muted },
});
