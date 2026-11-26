import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { normalizePhone } from "@shared/phone";
import { Text } from "../components/Text";
import { Button } from "../components/Button";
import { Chip } from "../components/Chip";
import { SportMark, SPORTS } from "../components/SportMark";
import { KeyboardAware } from "../components/KeyboardAware";
import { Empty, ErrorState, Loading } from "../components/StateView";
import { useSession } from "../lib/session";
import { sportName } from "../lib/days";
import {
  checkDetails, detailsPatch, missingForBooking, NAME_MAX, PHONE_HELP, PHONE_PRIVACY, saveProblem, useMyProfile, useSaveDetails, type Field,
} from "../lib/myProfile";
import { color, font, MAX_FONT_SCALE, radius, space, TOUCH } from "../lib/theme";

/**
 * Your details. Two uses:
 *  - before the first court booking (`?for=booking`): asks only for what is still missing — name, contact phone or
 *    both — then goes back to the club, which finishes the reservation the player chose;
 *  - from Profile: edit name, phone and (optional) sports at any time.
 * Browsing never needs this. The phone is the player's own answer: not checked, not assumed to be WhatsApp.
 */
export default function MyDetails() {
  const p = useLocalSearchParams<{ for?: string }>();
  const forBooking = p.for === "booking";
  const session = useSession();
  const userId = session.status === "signed-in" ? session.session.user.id : null;
  const profile = useMyProfile(userId);
  const save = useSaveDetails(userId);
  const ask: Field[] = useMemo(
    () => (forBooking ? missingForBooking(profile.data) : ["name", "phone"]),
    // the fields asked are fixed when the screen opens, so they don't disappear while being typed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [forBooking, profile.isSuccess],
  );
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [sports, setSports] = useState<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded || !profile.data) return;
    setLoaded(true);
    setName(profile.data.name ?? ""); setPhone(profile.data.phone ?? ""); setSports(profile.data.sports);
  }, [profile.data, loaded]);
  // reached for a booking with nothing missing (another device filled it in): straight back to the booking
  useEffect(() => { if (forBooking && profile.isSuccess && ask.length === 0) router.back(); }, [forBooking, profile.isSuccess, ask.length]);

  const title = forBooking ? "Before you book" : "Your details";
  const page = (body: React.ReactNode) => <><Stack.Screen options={{ title }} />{body}</>;
  if (!userId) return page(<Empty title="Sign in first" body="Your details are kept on your account." />);
  if (profile.isPending) return page(<Loading label="Loading your details" />);
  if (profile.isError && !profile.data) return page(<ErrorState error={profile.error} onRetry={() => void profile.refetch()} />);

  const saved = normalizePhone(phone.trim());
  const submit = async () => {
    const e = checkDetails({ name, phone }, ask, forBooking);
    setErrors(e); setProblem(null);
    if (Object.keys(e).length) return;
    try {
      await save.mutateAsync(detailsPatch({ name, phone, sports: forBooking ? undefined : sports }, ask));
      router.back();
    } catch (err) { setProblem(saveProblem(err)); }
  };
  const toggle = (s: string) => setSports((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return page(
    <KeyboardAware>
      <ScrollView style={styles.page} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text variant="secondary">
          {forBooking
            ? ask.length === 2 ? "The club needs your name and a number to reach you about this booking. We ask once." : ask[0] === "name" ? "The club needs your name for this booking. We ask once." : "The club needs a number to reach you about this booking. We ask once."
            : "Clubs see your name on your bookings."}
        </Text>
        {ask.includes("name") && (
          <View style={styles.field}>
            <Text variant="label" nativeID="name-label">Name</Text>
            <TextInput
              value={name} onChangeText={(t) => { setName(t); setErrors((x) => ({ ...x, name: undefined })); }} maxLength={NAME_MAX + 20}
              autoComplete="name" textContentType="name" autoCapitalize="words" returnKeyType="next" accessibilityLabelledBy="name-label"
              accessibilityLabel="Name" maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.input, errors.name && styles.inputBad]} testID="details-name"
            />
            {errors.name ? <Text style={styles.bad} accessibilityRole="alert">{errors.name}</Text> : null}
          </View>
        )}
        {ask.includes("phone") && (
          <View style={styles.field}>
            <Text variant="label" nativeID="phone-label">Contact phone{forBooking ? "" : " (needed to book a court)"}</Text>
            <TextInput
              value={phone} onChangeText={(t) => { setPhone(t); setErrors((x) => ({ ...x, phone: undefined })); }} maxLength={24}
              keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" placeholder="03 123 456 or +46 70 123 45 67" placeholderTextColor={color.booked}
              accessibilityLabelledBy="phone-label" accessibilityLabel="Contact phone" maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={[styles.input, errors.phone && styles.inputBad]} testID="details-phone" onSubmitEditing={() => void submit()}
            />
            {errors.phone ? <Text style={styles.bad} accessibilityRole="alert">{errors.phone}</Text>
              : saved && saved !== phone.trim() ? <Text variant="caption" testID="details-phone-saved-as">Saved as {saved}</Text> : null}
            <Text variant="caption">{PHONE_HELP}</Text>
            <Text variant="caption">{PHONE_PRIVACY}</Text>
          </View>
        )}
        {!forBooking && (
          <View style={styles.field}>
            <Text variant="label">Sports you play (optional)</Text>
            <View style={styles.chips}>
              {SPORTS.filter((s) => s !== "other").map((s) => (
                <Chip key={s} tone="sport" label={sportName(s)} selected={sports.includes(s)} onPress={() => toggle(s)} icon={<SportMark sport={s} size={20} />} />
              ))}
            </View>
            <Text variant="caption">Set a level for each sport in Profile. Neither is needed to book a court.</Text>
          </View>
        )}
        {problem ? <Text style={styles.bad} accessibilityRole="alert" testID="details-problem">{problem}</Text> : null}
        <Button label={forBooking ? "Save and continue" : "Save"} busy={save.isPending} onPress={() => void submit()} testID="details-save" />
        {!forBooking && <Button label="Cancel" variant="quiet" disabled={save.isPending} onPress={() => router.back()} />}
      </ScrollView>
    </KeyboardAware>,
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.lg, paddingBottom: space.xxxl },
  field: { gap: space.sm },
  input: {
    borderWidth: 1, borderColor: color.line, backgroundColor: color.card, borderRadius: radius.md, paddingHorizontal: 16, minHeight: TOUCH + 4,
    fontFamily: font.regular, fontSize: 16, color: color.ink,
  },
  inputBad: { borderColor: color.danger, borderWidth: 2 },
  bad: { fontFamily: font.semibold, fontSize: 15, color: color.danger },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
});
