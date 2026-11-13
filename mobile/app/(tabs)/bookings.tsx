import { ScrollView, StyleSheet, Text } from "react-native";
import { useSession } from "../../lib/session";
import { Loading } from "../../components/StateView";
import { SignInPrompt } from "../../components/SignInPrompt";
import { color, space, text, MAX_FONT_SCALE } from "../../lib/theme";

/** Signed-in only. The list itself is M2; M1 proves the signed-out and loading states. */
export default function Bookings() {
  const session = useSession();
  if (session.status === "loading") return <Loading label="Checking sign-in" />;
  if (session.status === "signed-out") {
    return <SignInPrompt title="Your bookings live here" body="Sign in to see your courts and the games you've joined." />;
  }
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>Your bookings appear here in the next milestone.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl },
  body: { ...text.body, color: color.muted },
});
