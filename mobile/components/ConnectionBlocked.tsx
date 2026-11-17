import { StyleSheet, Text, View } from "react-native";
import { color, font, space } from "../lib/theme";

/** Shown instead of the whole app when this build was given the wrong database. */
export function ConnectionBlocked({ message }: { message: string }) {
  return (
    <View style={styles.page} accessibilityRole="alert">
      <Text style={styles.title}>CourtBook can't connect</Text>
      <Text style={styles.body}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: "center", padding: space.xxl, gap: space.md, backgroundColor: color.ground },
  title: { fontFamily: font.display, fontSize: 24, color: color.ink },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 23, color: color.ink },
});
