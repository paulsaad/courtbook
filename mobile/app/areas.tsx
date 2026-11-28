import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Text } from "../components/Text";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { Empty, ErrorState, Loading } from "../components/StateView";
import { areaKey, MAX_AREAS, sameArea, type PlayingArea } from "@shared/places";
import { useAreaList } from "../lib/clubDirectory";
import { usePlayingPrefs, useSaveAreas } from "../lib/playing";
import { useSession } from "../lib/session";
import { supabase } from "../lib/supabase";
import { color, font, radius, space } from "../lib/theme";

/**
 * Where I play (0088): the player's areas — governorate, optionally a district, optionally a town — in their order,
 * kept on the account so they are the same on every device. Up to 10. Saving also answers the first-use question.
 */
type Step = { gov: string | null; district: string | null };

export default function Areas() {
  const insets = useSafeAreaInsets();   // A17: a long list must end above Android's navigation bar (edge to edge)
  const session = useSession();
  const userId = session.status === "signed-in" ? session.session.user.id : null;
  const prefs = usePlayingPrefs(userId);
  const save = useSaveAreas(userId);
  const govs = useAreaList();
  const [step, setStep] = useState<Step | null>(null);
  const towns = useQuery({
    queryKey: ["towns", step?.district ?? ""], enabled: !!step?.district, staleTime: 24 * 3_600_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("towns").select("id, name_en").eq("district_code", step!.district!).order("name_en");
      if (error) throw error;
      return (data ?? []) as { id: string; name_en: string }[];
    },
  });

  if (!userId) return <Empty title="Sign in to save your areas" body="Your areas are kept on your account, so they follow you to every device." />;
  if (prefs.isPending || govs.isPending) return <Loading label="Loading your areas" />;
  if (prefs.isError) return <ErrorState error={prefs.error} onRetry={() => void prefs.refetch()} />;
  if (!prefs.data) return <Empty title="Not available yet" body="Saving areas isn't available on this server yet." />;
  const areas = prefs.data.areas;
  const g = govs.data?.find((x) => x.code === step?.gov);

  const commit = async (next: PlayingArea[]) => {
    try { await save.mutateAsync(next); setStep(null); }
    catch (e) {
      Alert.alert("Not saved", (e as Error).message === "too_many_areas" ? `You can keep up to ${MAX_AREAS} areas.` : "Couldn't save your areas. Check your connection and try again.");
    }
  };
  const add = (a: PlayingArea) => (areas.some((x) => sameArea(x, a)) ? setStep(null) : void commit([...areas, a]));
  const row = (label: string, onPress: () => void, testID?: string, chevron = true) => (
    <Pressable key={testID ?? label} accessibilityRole="button" onPress={onPress} style={styles.row} testID={testID} disabled={save.isPending}>
      <Text style={styles.rowText}>{label}</Text>
      {chevron ? <Icon name="chevronRight" size={20} color={color.muted} /> : null}
    </Pressable>
  );

  return (
    <ScrollView style={styles.page} contentContainerStyle={[styles.content, { paddingBottom: 40 + insets.bottom }]}>
      <Text variant="secondary">Your areas are one tap away on Courts, on every device.</Text>
      {areas.length === 0 ? <Text>No areas yet.</Text> : (
        <View style={styles.list}>
          {areas.map((a) => (
            <View key={areaKey(a)} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowText}>{a.label ?? a.governorate}</Text>
                {a.within ? <Text variant="secondary">{a.within}</Text> : null}
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${a.label ?? a.governorate}`} onPress={() => void commit(areas.filter((x) => !sameArea(x, a)))}
                style={styles.remove} disabled={save.isPending} testID={`remove-${areaKey(a)}`}>
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {areas.length >= MAX_AREAS ? <Text variant="secondary">You can keep up to {MAX_AREAS} areas.</Text>
        : step === null ? <Button label="Add an area" variant="secondary" onPress={() => setStep({ gov: null, district: null })} testID="areas-add" />
        : (
          <View style={styles.list} testID="areas-picker">
            {!g && (govs.data ?? []).map((x) => row(x.name_en, () => setStep({ gov: x.code, district: null }), `gov-${x.code}`))}
            {g && !step?.district && (
              <>
                {row(`All of ${g.name_en}`, () => add({ governorate: g.code, district: null, town: null, label: g.name_en }), `all-${g.code}`, false)}
                {g.districts.map((d) => row(d.name_en, () => setStep({ gov: g.code, district: d.code }), `district-${d.code}`))}
              </>
            )}
            {g && step?.district && (
              <>
                {row(`The whole of ${g.districts.find((d) => d.code === step.district)?.name_en ?? "this district"}`,
                  () => add({ governorate: g.code, district: step.district, town: null, label: g.districts.find((d) => d.code === step.district)?.name_en }), `whole-${step.district}`, false)}
                {towns.isPending ? <Loading label="Loading towns" /> : (towns.data ?? []).map((t) =>
                  row(t.name_en, () => add({ governorate: g.code, district: step.district, town: t.id, label: t.name_en }), `town-${t.id}`, false))}
              </>
            )}
            <Button label="Cancel" variant="quiet" onPress={() => setStep(null)} />
          </View>
        )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ground },
  content: { padding: space.xl, gap: space.lg, paddingBottom: 40 },
  list: { backgroundColor: color.card, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 52, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.line },
  rowText: { flex: 1, fontFamily: font.regular, fontSize: 16, color: color.ink },
  remove: { minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: space.sm },
  removeText: { fontFamily: font.semibold, fontSize: 15, color: color.cedar },
});
